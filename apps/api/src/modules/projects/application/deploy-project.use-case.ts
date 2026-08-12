import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { DetectedStack } from "@korrelo/shared-types";
import { apiError } from "../../../infrastructure/api-error";
import type { Project } from "../domain/project.entity";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { DOCKERFILE_GENERATOR, type DockerfileGenerator } from "../domain/dockerfile-generator";
import {
  CONTAINER_ORCHESTRATOR,
  COMPOSE_FILENAME,
  ENV_FILENAME,
  type ContainerOrchestrator,
  type DeployConfig,
} from "../domain/container-orchestrator";
import { HEALTH_CHECKER, type HealthChecker } from "../domain/health-checker";
import { ENV_VAR_REPOSITORY, type EnvVarRepository } from "../domain/env-var.repository";
import {
  MANAGED_DATABASE_REPOSITORY,
  type ManagedDatabaseRepository,
} from "../domain/managed-database.repository";
import { DEPLOY_RECORD_REPOSITORY, type DeployRecordRepository } from "../domain/deploy-record.repository";
import { DeployRecord, type DeployTrigger } from "../domain/deploy-record.entity";
import { REPOSITORY_CLONER, type RepositoryCloner } from "../domain/repository-cloner";
import { GITHUB_APP_CLIENT, type GithubAppClient } from "../../github/domain/github-app-client";
import {
  GITHUB_INSTALLATION_REPOSITORY,
  type GithubInstallationRepository,
} from "../../github/domain/github-installation.repository";
import { PortAllocator } from "../infrastructure/port-allocator";
import { ResourceBudgetCalculator } from "../infrastructure/resource-budget-calculator";
import { DockerComposeFileBuilder } from "../infrastructure/docker-compose-file-builder";
import { getProjectWorkspacePath } from "../infrastructure/workspace-paths";

const HEALTH_CHECK_TIMEOUT_MS = 30_000;

function sanitizeContainerName(projectId: string, projectName: string): string {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `korrelo-${slug || "project"}-${projectId.slice(0, 8)}`;
}

@Injectable()
export class DeployProjectUseCase {
  private readonly logger = new Logger(DeployProjectUseCase.name);
  // Duas chamadas concorrentes pro mesmo projeto (ex.: um push automático
  // caindo bem na hora de um deploy manual) escreveriam o mesmo
  // docker-compose.korrelo.yml ao mesmo tempo, corrompendo o arquivo. Essa
  // fila encadeia execuções do MESMO projeto sem bloquear projetos diferentes.
  private readonly deployQueues = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly repository: ProjectRepository,
    @Inject(DOCKERFILE_GENERATOR) private readonly dockerfileGenerator: DockerfileGenerator,
    @Inject(CONTAINER_ORCHESTRATOR) private readonly orchestrator: ContainerOrchestrator,
    @Inject(HEALTH_CHECKER) private readonly healthChecker: HealthChecker,
    @Inject(ENV_VAR_REPOSITORY) private readonly envVarRepository: EnvVarRepository,
    @Inject(MANAGED_DATABASE_REPOSITORY) private readonly managedDatabaseRepository: ManagedDatabaseRepository,
    @Inject(DEPLOY_RECORD_REPOSITORY) private readonly deployRecordRepository: DeployRecordRepository,
    @Inject(REPOSITORY_CLONER) private readonly cloner: RepositoryCloner,
    @Inject(GITHUB_APP_CLIENT) private readonly githubAppClient: GithubAppClient,
    @Inject(GITHUB_INSTALLATION_REPOSITORY)
    private readonly githubInstallationRepository: GithubInstallationRepository,
    private readonly portAllocator: PortAllocator,
    private readonly resourceBudget: ResourceBudgetCalculator,
    private readonly composeFileBuilder: DockerComposeFileBuilder,
  ) {}

  async execute(projectId: string, triggeredBy: DeployTrigger = "manual"): Promise<Project> {
    const previous = this.deployQueues.get(projectId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.runDeploy(projectId, triggeredBy));
    this.deployQueues.set(projectId, run);
    try {
      return await run;
    } finally {
      // Só limpa se ninguém encadeou outro deploy por trás desse enquanto
      // ele rodava (senão apagaria a referência do deploy mais novo).
      if (this.deployQueues.get(projectId) === run) {
        this.deployQueues.delete(projectId);
      }
    }
  }

  private async runDeploy(projectId: string, triggeredBy: DeployTrigger): Promise<Project> {
    const project = await this.repository.findById(projectId);
    if (!project) {
      throw new NotFoundException(apiError("PROJECT_NOT_FOUND", `Projeto ${projectId} não encontrado`));
    }
    if (!project.detectedStack) {
      throw new BadRequestException(
        apiError(
          "PROJECT_STACK_NOT_DETECTED",
          "Este projeto ainda não tem stack detectada. Rode /import ou /detect-stack antes do deploy.",
        ),
      );
    }

    let deployRecord = await this.deployRecordRepository.save(DeployRecord.start(projectId, triggeredBy));

    const stack = JSON.parse(project.detectedStack) as DetectedStack;
    const projectPath = getProjectWorkspacePath(project.id);

    // Sem isso o deploy só reconstruía a imagem em cima do código já clonado
    // no /import, nunca pegando commits novos - webhook e deploy manual
    // ficavam presos pra sempre na versão importada originalmente.
    const accessToken = await this.resolveGithubAccessToken();
    await this.cloner.cloneOrUpdate(project.repoUrl, projectPath, accessToken);
    const lastCommit = await this.cloner.getLastCommit(projectPath);
    if (lastCommit) {
      deployRecord = await this.deployRecordRepository.save(deployRecord.withCommit(lastCommit.hash, lastCommit.message));
    }

    const { dockerfile, dockerignore } = this.dockerfileGenerator.generate(stack);
    await fs.writeFile(path.join(projectPath, "Dockerfile"), dockerfile, "utf-8");
    await fs.writeFile(path.join(projectPath, ".dockerignore"), dockerignore, "utf-8");

    const containerPort = stack.recommendedPort ?? 3000;
    // Porta estável entre redeploys: sem isso, cada deploy corria o risco de
    // cair numa porta diferente (a porta atual do projeto conta como "em uso"
    // pelo próprio container antigo ainda rodando), quebrando silenciosamente
    // um domínio personalizado já anexado.
    const hostPort = project.assignedPort ?? (await this.portAllocator.allocate(containerPort));
    const containerName = sanitizeContainerName(project.id, project.name);
    const stagingContainerName = `${containerName}-staging`;
    const stagingHostPort = await this.portAllocator.allocate(hostPort + 1);
    const memoryLimitMb = await this.resourceBudget.getContainerMemoryLimitMb(project.id);

    const managedDatabase = await this.managedDatabaseRepository.findByProjectId(project.id);
    // Bancos "custom" são externos (o usuário cola a própria connection string),
    // então o Korrelo nunca sobe container pra eles, só injeta a env var.
    const managedContainerDatabase =
      managedDatabase && managedDatabase.type !== "custom" ? managedDatabase : null;

    const deployConfig: DeployConfig = {
      projectPath,
      containerName,
      hostPort,
      containerPort,
      memoryLimitMb,
      staging: { containerName: stagingContainerName, hostPort: stagingHostPort },
      database: managedContainerDatabase
        ? {
            type: managedContainerDatabase.type as "postgres" | "redis" | "mongodb",
            username: managedContainerDatabase.username as string,
            password: managedContainerDatabase.password as string,
            databaseName: managedContainerDatabase.databaseName as string,
            // Metade do orçamento do app: bancos gerenciados são um extra, não
            // podem competir igualmente pela RAM já apertada de uma VPS pequena.
            memoryLimitMb: Math.round(memoryLimitMb / 2),
            persistent: managedContainerDatabase.persistent,
          }
        : undefined,
    };

    const composeContent = this.composeFileBuilder.build(deployConfig);
    await fs.writeFile(path.join(projectPath, COMPOSE_FILENAME), composeContent, "utf-8");

    // O compose sempre referencia esse arquivo via env_file, então precisa existir
    // mesmo vazio, ou o `docker compose up` falha procurando um arquivo que não está lá.
    const envVars = await this.envVarRepository.findByProjectId(project.id);
    const envFileContent = envVars.map((v) => `${v.key}=${v.value}`).join("\n") + "\n";
    await fs.writeFile(path.join(projectPath, ENV_FILENAME), envFileContent, "utf-8");

    // Fase 1: builda e sobe só a instância de teste. A versão em produção (se
    // já existir) continua no ar o tempo todo, sem ser tocada.
    let record = deployRecord;
    try {
      const stagingLog = await this.orchestrator.deployStaging(deployConfig);
      record = record.appendLog(`--- build/staging ---\n${stagingLog}`);
      await this.deployRecordRepository.save(record);
    } catch (error) {
      await this.removeStagingIgnoringErrors(deployConfig);
      await this.repository.save(project.withFailedDeployment());
      const message = error instanceof Error ? error.message : String(error);
      await this.deployRecordRepository.save(record.appendLog(message).withResult("failed", message));
      throw error;
    }

    const stagingHealthy = await this.healthChecker.waitUntilHealthy(stagingHostPort, HEALTH_CHECK_TIMEOUT_MS);
    if (!stagingHealthy) {
      await this.removeStagingIgnoringErrors(deployConfig);
      await this.repository.save(project.withFailedDeployment());
      const message = `Container de teste subiu mas não respondeu em ${HEALTH_CHECK_TIMEOUT_MS / 1000}s. A versão em produção não foi tocada.`;
      await this.deployRecordRepository.save(record.withResult("failed", message));
      throw new InternalServerErrorException(
        apiError("DEPLOY_HEALTH_CHECK_FAILED", `Deploy cancelado: ${message}`),
      );
    }

    // Fase 2: já validado, agora sim troca a versão em produção. Reaproveita a
    // imagem recém-buildada (cache), então essa troca é rápida - segundos, não
    // o tempo do build inteiro.
    try {
      const promoteLog = await this.orchestrator.promote(deployConfig);
      record = record.appendLog(`--- promote ---\n${promoteLog}`);
      await this.deployRecordRepository.save(record);
    } catch (error) {
      await this.removeStagingIgnoringErrors(deployConfig);
      await this.repository.save(project.withFailedDeployment());
      const message = error instanceof Error ? error.message : String(error);
      await this.deployRecordRepository.save(record.appendLog(message).withResult("failed", message));
      throw error;
    }

    const healthy = await this.healthChecker.waitUntilHealthy(hostPort, HEALTH_CHECK_TIMEOUT_MS);
    await this.removeStagingIgnoringErrors(deployConfig);

    if (!healthy) {
      await this.repository.save(project.withFailedDeployment());
      const message = `A versão trocada não respondeu na porta final ${hostPort} depois da promoção.`;
      await this.deployRecordRepository.save(record.withResult("failed", message));
      throw new InternalServerErrorException(
        apiError("DEPLOY_HEALTH_CHECK_FAILED", `Deploy cancelado: ${message}`),
      );
    }

    await this.deployRecordRepository.save(record.withResult("success", null));
    const deployedProject = project.withDeployment(containerName, hostPort);
    return this.repository.save(deployedProject);
  }

  private async resolveGithubAccessToken(): Promise<string | undefined> {
    const installation = await this.githubInstallationRepository.findLatest();
    if (!installation) return undefined;

    const { token } = await this.githubAppClient.createInstallationToken(installation.installationId);
    return token;
  }

  private async removeStagingIgnoringErrors(config: { projectPath: string; containerName: string }): Promise<void> {
    try {
      await this.orchestrator.removeStaging(config);
    } catch (error) {
      this.logger.error(`Falha ao remover container de teste: ${error}`);
    }
  }
}
