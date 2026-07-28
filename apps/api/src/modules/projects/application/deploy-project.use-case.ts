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
import type { DetectedStack } from "@forgedesk/shared-types";
import type { Project } from "../domain/project.entity";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { DOCKERFILE_GENERATOR, type DockerfileGenerator } from "../domain/dockerfile-generator";
import {
  CONTAINER_ORCHESTRATOR,
  COMPOSE_FILENAME,
  ENV_FILENAME,
  type ContainerOrchestrator,
  type TeardownConfig,
} from "../domain/container-orchestrator";
import { HEALTH_CHECKER, type HealthChecker } from "../domain/health-checker";
import { ENV_VAR_REPOSITORY, type EnvVarRepository } from "../domain/env-var.repository";
import {
  MANAGED_DATABASE_REPOSITORY,
  type ManagedDatabaseRepository,
} from "../domain/managed-database.repository";
import { PortAllocator } from "../infrastructure/port-allocator";
import { ResourceBudgetCalculator } from "../infrastructure/resource-budget-calculator";
import { DockerComposeFileBuilder } from "../infrastructure/docker-compose-file-builder";
import { getProjectWorkspacePath } from "../infrastructure/workspace-paths";

const HEALTH_CHECK_TIMEOUT_MS = 30_000;

function sanitizeContainerName(projectId: string, projectName: string): string {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `forgedesk-${slug || "project"}-${projectId.slice(0, 8)}`;
}

@Injectable()
export class DeployProjectUseCase {
  private readonly logger = new Logger(DeployProjectUseCase.name);

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly repository: ProjectRepository,
    @Inject(DOCKERFILE_GENERATOR) private readonly dockerfileGenerator: DockerfileGenerator,
    @Inject(CONTAINER_ORCHESTRATOR) private readonly orchestrator: ContainerOrchestrator,
    @Inject(HEALTH_CHECKER) private readonly healthChecker: HealthChecker,
    @Inject(ENV_VAR_REPOSITORY) private readonly envVarRepository: EnvVarRepository,
    @Inject(MANAGED_DATABASE_REPOSITORY) private readonly managedDatabaseRepository: ManagedDatabaseRepository,
    private readonly portAllocator: PortAllocator,
    private readonly resourceBudget: ResourceBudgetCalculator,
    private readonly composeFileBuilder: DockerComposeFileBuilder,
  ) {}

  async execute(projectId: string): Promise<Project> {
    const project = await this.repository.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Projeto ${projectId} não encontrado`);
    }
    if (!project.detectedStack) {
      throw new BadRequestException(
        "Este projeto ainda não tem stack detectada. Rode /import ou /detect-stack antes do deploy.",
      );
    }

    const stack = JSON.parse(project.detectedStack) as DetectedStack;
    const projectPath = getProjectWorkspacePath(project.id);

    const { dockerfile, dockerignore } = this.dockerfileGenerator.generate(stack);
    await fs.writeFile(path.join(projectPath, "Dockerfile"), dockerfile, "utf-8");
    await fs.writeFile(path.join(projectPath, ".dockerignore"), dockerignore, "utf-8");

    const containerPort = stack.recommendedPort ?? 3000;
    const hostPort = await this.portAllocator.allocate(containerPort);
    const containerName = sanitizeContainerName(project.id, project.name);
    const memoryLimitMb = this.resourceBudget.getContainerMemoryLimitMb();

    const managedDatabase = await this.managedDatabaseRepository.findByProjectId(project.id);

    const deployConfig = {
      projectPath,
      containerName,
      hostPort,
      containerPort,
      memoryLimitMb,
      database: managedDatabase
        ? {
            type: managedDatabase.type,
            username: managedDatabase.username,
            password: managedDatabase.password,
            databaseName: managedDatabase.databaseName,
            // Metade do orçamento do app: bancos gerenciados são um extra, não
            // podem competir igualmente pela RAM já apertada de uma VPS pequena.
            memoryLimitMb: Math.round(memoryLimitMb / 2),
          }
        : undefined,
    };

    const composeContent = this.composeFileBuilder.build(deployConfig);
    await fs.writeFile(path.join(projectPath, COMPOSE_FILENAME), composeContent, "utf-8");

    // O compose sempre referencia esse arquivo via env_file — precisa existir mesmo
    // vazio, ou o `docker compose up` falha procurando um arquivo que não está lá.
    const envVars = await this.envVarRepository.findByProjectId(project.id);
    const envFileContent = envVars.map((v) => `${v.key}=${v.value}`).join("\n") + "\n";
    await fs.writeFile(path.join(projectPath, ENV_FILENAME), envFileContent, "utf-8");

    try {
      await this.orchestrator.deploy(deployConfig);
    } catch (error) {
      await this.rollback(deployConfig, "o container não subiu");
      await this.repository.save(project.withFailedDeployment());
      throw error;
    }

    const healthy = await this.healthChecker.waitUntilHealthy(hostPort, HEALTH_CHECK_TIMEOUT_MS);
    if (!healthy) {
      await this.rollback(deployConfig, "falhou no health check");
      await this.repository.save(project.withFailedDeployment());
      throw new InternalServerErrorException(
        `Deploy cancelado: o container subiu mas não respondeu na porta ${hostPort} em ${HEALTH_CHECK_TIMEOUT_MS / 1000}s. Rollback automático executado.`,
      );
    }

    const deployedProject = project.withDeployment(containerName, hostPort);
    return this.repository.save(deployedProject);
  }

  private async rollback(config: TeardownConfig, reason: string): Promise<void> {
    this.logger.warn(`Rollback: ${reason} (${config.containerName}) — removendo container`);
    try {
      await this.orchestrator.teardown(config);
    } catch (teardownError) {
      // Não deixa o erro do rollback mascarar a causa original da falha do deploy.
      this.logger.error(`Falha ao limpar container após rollback: ${teardownError}`);
    }
  }
}
