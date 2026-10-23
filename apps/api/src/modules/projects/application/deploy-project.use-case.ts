import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DetectedStack } from "@korrelo/shared-types";
import { apiError } from "../../../infrastructure/api-error";
import type { Project } from "../domain/project.entity";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { DOCKERFILE_GENERATOR, type DockerfileGenerator } from "../domain/dockerfile-generator";
import {
  CONTAINER_ORCHESTRATOR,
  COMPOSE_FILENAME,
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
import { DeployRecord } from "../domain/deploy-record.entity";
import { REPOSITORY_CLONER, type RepositoryCloner } from "../domain/repository-cloner";
import { GITHUB_APP_CLIENT, type GithubAppClient } from "../../github/domain/github-app-client";
import {
  GITHUB_INSTALLATION_REPOSITORY,
  type GithubInstallationRepository,
} from "../../github/domain/github-installation.repository";
import { PortAllocator } from "../infrastructure/port-allocator";
import { DockerComposeFileBuilder } from "../infrastructure/docker-compose-file-builder";
import {
  getProjectSecretsDir,
  getProjectSecretsPath,
  getProjectStagingSecretsPath,
  getProjectWorkspacePath,
} from "../infrastructure/workspace-paths";
import {
  computeDeploymentMemoryPlan,
  type DeploymentMemoryPlan,
} from "../infrastructure/memory-budget";
import { ensureDockerignore } from "../infrastructure/dockerignore";
import { DeployLogger } from "../infrastructure/deploy-logger";
import { ResourcePreflightService } from "../infrastructure/resource-preflight.service";
import { WorkerLock } from "../infrastructure/worker-lock";
import {
  defaultSelfUpdateState,
  type SelfUpdateStateLike,
} from "../../../infrastructure/self-update-state";
import {
  StagingDiagnosticsCollector,
  formatStagingDiagnostics,
  sanitizeDiagnosticText,
  type StagingDiagnosticsCollectorLike,
} from "../infrastructure/staging-diagnostics";
import { DEPLOY_JOB_REPOSITORY, type DeployJobRepository } from "../domain/deploy-job.repository";
import { DeployJob, type DeployJobStage } from "../domain/deploy-job.entity";
import { decideStagingHealthTimeout } from "../domain/staging-config";
import {
  STAGING_DEPLOY_ENV_VAR,
  STAGING_ENV_PREFIX,
} from "../domain/staging-config";
import type { HealthcheckConfig } from "../domain/container-orchestrator";

const HEALTH_CHECK_TIMEOUT_MS = 30_000;

/**
 * Timeout (segundos) da espera de health do container de TESTE.
 *
 * O default é o mesmo de sempre (30s). Um projeto pode ter o SEU próprio
 * timeout - o Mesatta, por exemplo, tem `start_period: 90s` no healthcheck
 * Docker e o bootstrap do Next numa VPS de 1 vCPU demora mais que 30s.
 *
 * Este timeout vale SÓ para o staging: a espera de health da PRODUÇÃO
 * continua com `HEALTH_CHECK_TIMEOUT_MS`.
 */
const DEFAULT_STAGING_HEALTH_TIMEOUT_SECONDS = HEALTH_CHECK_TIMEOUT_MS / 1000;

/** Erro de deploy com a informação de se a produção foi afetada. */
class DeployFailure extends Error {
  constructor(
    message: string,
    readonly productionAffected: boolean,
  ) {
    super(message);
    this.name = "DeployFailure";
  }
}

function sanitizeContainerName(projectId: string, projectName: string): string {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `korrelo-${slug || "project"}-${projectId.slice(0, 8)}`;
}

/**
 * Executa UM job de deploy (a fila global garante um por vez).
 *
 * Fluxo (Wave 2):
 *   fetching → building (staging) → staging-health → promote →
 *   production-health → (rollback) → cleanup → complete
 *
 * Invariantes:
 * - a produção só é tocada DEPOIS que a instância de teste passou no
 *   health check;
 * - se a nova versão falhar na produção, a imagem anterior é restaurada
 *   (rollback) - o volume/banco NÃO são tocados;
 * - o container de teste é removido SEMPRE (finally);
 * - falha de deploy NÃO derruba o estado de runtime da aplicação (a versão
 *   anterior continua no ar e o cron/backup/terminal continuam funcionando).
 */
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
    @Inject(DEPLOY_RECORD_REPOSITORY) private readonly deployRecordRepository: DeployRecordRepository,
    @Inject(REPOSITORY_CLONER) private readonly cloner: RepositoryCloner,
    @Inject(GITHUB_APP_CLIENT) private readonly githubAppClient: GithubAppClient,
    @Inject(GITHUB_INSTALLATION_REPOSITORY)
    private readonly githubInstallationRepository: GithubInstallationRepository,
    private readonly portAllocator: PortAllocator,
    private readonly composeFileBuilder: DockerComposeFileBuilder,
    @Inject(DEPLOY_JOB_REPOSITORY) private readonly deployJobRepository: DeployJobRepository,
    private readonly deployLogger: DeployLogger,
    private readonly resourcePreflight: ResourcePreflightService,
    /**
     * Coletor do diagnóstico do staging (opcional: sem ele, o padrão lê o
     * Docker). Usado SÓ para observabilidade - nunca altera o deploy.
     */
    @Optional()
    private readonly stagingDiagnostics: StagingDiagnosticsCollectorLike | null = null,
    /**
     * Lock do worker de deploy - o MESMO que a fila segura enquanto o job
     * roda. A limpeza de cache só executa se este processo for o dono dele
     * (ou seja, nenhum outro worker está buildando neste instante).
     */
    @Optional()
    private readonly deployLock?: WorkerLock,
    /**
     * Estado do self-update (lock do rollout). Injetável nos testes; em
     * produção lê ~/.korrelo/self-update.lock no momento da limpeza.
     */
    @Optional()
    private readonly selfUpdateState: SelfUpdateStateLike | null = null,
  ) {}

  async executeJob(job: DeployJob): Promise<void> {
    const context = {
      deployJobId: job.id,
      projectId: job.projectId,
      commitSha: job.commitSha,
    };
    // Job "staging": constrói, sobe o container de teste, roda o health e
    // remove — SEM promover. O fluxo padrão (manual/webhook) continua
    // promovendo automaticamente quando o staging passa.
    const stagingOnly = job.trigger === "staging";

    const project = await this.repository.findById(job.projectId);
    if (!project) {
      throw new NotFoundException(apiError("PROJECT_NOT_FOUND", `Projeto ${job.projectId} não encontrado`));
    }
    if (!project.detectedStack) {
      throw new BadRequestException(
        apiError(
          "PROJECT_STACK_NOT_DETECTED",
          "Este projeto ainda não tem stack detectada. Rode /import ou /detect-stack antes do deploy.",
        ),
      );
    }

    const stack = JSON.parse(project.detectedStack) as DetectedStack;
    const projectPath = getProjectWorkspacePath(project.id);
    let deployRecord = await this.deployRecordRepository.save(DeployRecord.start(project.id, job.trigger));

    let deployConfig: DeployConfig | null = null;
    let promoted = false;
    let rollbackSucceeded = false;
    let stagingRemoved = false;
    let stagingCreated = false;
    let candidateImage: string | null = null;
    let previousImage: string | null = null;

    try {
      // ------------------------------------------------------------------
      // 1. fetching: workspace no commit exato do job
      // ------------------------------------------------------------------
      await this.setStage(job, "fetching", context);
      const accessToken = await this.resolveGithubAccessToken();
      const prepared = await this.cloner.prepareCommit(project.repoUrl, projectPath, accessToken, {
        branch: job.branch,
        commitSha: job.commitSha,
      });
      this.deployLogger.log("fetching", { ...context, commitSha: prepared.sha }, "workspace preparado", {
        branch: job.branch,
      });

      if (!job.commitSha) {
        // Deploy manual: o commit só é conhecido agora. Só é gravado no job
        // se ainda não existir outro job com o mesmo (projeto, commit) - a
        // unicidade lógica impede dois jobs do mesmo commit.
        const existing = await this.deployJobRepository.findByProjectAndCommit(project.id, prepared.sha);
        if (!existing || existing.id === job.id) {
          await this.deployJobRepository.save(job.withCommit(prepared.sha));
        }
      }
      deployRecord = await this.deployRecordRepository.save(
        deployRecord.withCommit(prepared.sha.slice(0, 7), prepared.message),
      );

      // ------------------------------------------------------------------
      // 2. orçamento de memória (app + banco + staging na mesma fatia),
      //    respeitando o grandfathering: um projeto que já roda NUNCA tem
      //    o limite reduzido automaticamente.
      // ------------------------------------------------------------------
      const plan = await this.computeMemoryPlan(project);
      this.deployLogger.log("fetching", context, "orçamento de memória calculado", {
        productionLimitMb: plan.productionLimitMb,
        limitSource: plan.effective.source,
        grandfathered: plan.effective.grandfathered,
        stagingLimitMb: plan.stagingLimitMb,
        stagingLimitSource: plan.stagingLimitSource,
        databaseBudgetTotalMb: plan.databaseBudgetTotalMb,
      });
      if (plan.stagingLimitNote) {
        this.deployLogger.log("fetching", context, plan.stagingLimitNote, {
          stagingLimitMb: plan.stagingLimitMb,
          stagingLimitSource: plan.stagingLimitSource,
          productionLimitMb: plan.productionLimitMb,
        });
      }

      if (plan.requiresExplicitConfirmation) {
        // O admin pediu um limite MENOR que o do container em execução:
        // isso não é aplicado sozinho (reduzir memória de um app no ar pode
        // matá-lo por OOM). O deploy para com a explicação.
        throw new DeployFailure(
          plan.effective.note ??
            "Reduzir o limite de memória de um projeto em execução exige confirmação explícita.",
          false,
        );
      }

      if (project.status === "running" && project.productionMemoryLimitMb === null) {
        // O projeto está rodando, mas o Core ainda não sabe o limite atual
        // do container (reconciliação pendente ou Docker indisponível no
        // boot). Sem esse dado, um deploy poderia DIMINUIR a memória de um
        // app no ar. Melhor travar o deploy até a reconciliação acontecer.
        throw new DeployFailure(
          "O limite de memória atual do container de produção é desconhecido (reconciliação pendente). " +
            "O deploy fica bloqueado até o Korrelo conseguir ler o estado real do container - é isso que impede " +
            "que a memória de uma aplicação no ar seja diminuída sem querer.",
          false,
        );
      }

      // ------------------------------------------------------------------
      // 3. imagem versionada por commit
      // ------------------------------------------------------------------
      const imageName = sanitizeContainerName(project.id, project.name);
      const imageTag = `commit-${prepared.sha.slice(0, 12)}`;
      candidateImage = `${imageName}:${imageTag}`;
      previousImage = project.currentImage;
      await this.deployJobRepository.save(
        job.withImageInfo({ previousImage, candidateImage, imageTag }),
      );

      // ------------------------------------------------------------------
      // 4. arquivos: secrets FORA do contexto, .dockerignore garantido,
      //    compose com a tag da imagem
      // ------------------------------------------------------------------
      const envFiles = await this.writeEnvFile(project);
      // O workspace sempre existe depois do clone, mas garantimos aqui: um
      // diretório faltando faria o deploy falhar na hora de escrever o
      // compose (e a produção nem seria tocada).
      await fs.mkdir(projectPath, { recursive: true });
      const dockerignore = await ensureDockerignore(projectPath);
      if (dockerignore.added.length > 0) {
        this.deployLogger.log(
          "fetching",
          context,
          `.dockerignore atualizado (entradas obrigatórias adicionadas: ${dockerignore.added.join(", ")})`,
        );
      }

      const containerName = imageName;
      const stagingContainerName = `${containerName}-staging`;
      const hostPort = project.assignedPort ?? (await this.portAllocator.allocate(stack.recommendedPort ?? 3000));
      const stagingHostPort = await this.portAllocator.allocate(hostPort + 1);

      const allManagedDatabases = await this.managedDatabaseRepository.findAllByProjectId(project.id);
      const managedContainerDatabases = allManagedDatabases.filter((db) => db.type !== "custom");
      // O budget de banco é TOTAL por projeto e dividido entre os bancos
      // (Postgres + Redis NÃO recebem o budget inteiro cada um).
      const dbLimitByType = new Map(plan.databaseLimits.map((limit) => [limit.type, limit.limitMb]));

      deployConfig = {
        projectPath,
        containerName,
        hostPort,
        containerPort: stack.recommendedPort ?? 3000,
        memoryLimitMb: plan.productionLimitMb,
        staging: {
          containerName: stagingContainerName,
          hostPort: stagingHostPort,
          memoryLimitMb: plan.stagingLimitMb,
        },
        databases: managedContainerDatabases.map((db) => ({
          type: db.type as "postgres" | "redis" | "mongodb",
          serviceName: db.serviceName as string,
          username: db.username as string,
          password: db.password as string,
          databaseName: db.databaseName as string,
          memoryLimitMb: dbLimitByType.get(db.type as "postgres" | "redis" | "mongodb") ?? 0,
          persistent: db.persistent,
        })),
        imageName,
        imageTag,
        envFilePath: envFiles.envFilePath,
        stagingEnvFilePath: envFiles.stagingEnvFilePath,
        projectId: project.id,
        deployJobId: job.id,
        commitSha: prepared.sha,
        healthcheck: this.parseHealthcheckConfig(project),
        memswapLimitMb: this.parseMemswapLimitMb(),
      };

      // Dockerfile próprio do projeto tem precedência (o dono do projeto
      // sabe o que está fazendo) - mas o .dockerignore obrigatório já foi
      // garantido acima (o segredo NÃO entra no contexto).
      const hasCustomDockerfile = await fileExists(path.join(projectPath, "Dockerfile"));
      if (!hasCustomDockerfile) {
        const { dockerfile, dockerignore: generatedIgnore } = this.dockerfileGenerator.generate(stack, {
          useCacheMounts: await this.orchestrator.supportsBuildKit(),
          buildMemoryMb: plan.stagingLimitMb,
        });
        await fs.writeFile(path.join(projectPath, "Dockerfile"), dockerfile, "utf-8");
        if (!(await fileExists(path.join(projectPath, ".dockerignore")))) {
          await fs.writeFile(path.join(projectPath, ".dockerignore"), generatedIgnore, "utf-8");
        }
      }

      const composeContent = this.composeFileBuilder.build(deployConfig, stack.language);
      await fs.writeFile(path.join(projectPath, COMPOSE_FILENAME), composeContent, "utf-8");

      // ------------------------------------------------------------------
      // 5. staging: builda e sobe a instância de teste
      //
      // Antes do build pesado, ESPERA o host ficar seguro (load, RAM, disco,
      // swap/PSI). A pressão depois do clone/fetch é transitória - abortar o
      // deploy por causa dela é desperdício. A produção em execução NUNCA é
      // parada, reduzida ou reiniciada para liberar recurso.
      // ------------------------------------------------------------------
      if (stagingOnly || !project.skipStagingTest) {
        await this.setStage(job, "staging-start", context);
        const hostWait = await this.resourcePreflight.waitForSafeHost({
          // A política é a MESMA do preflight da fila: requisito base do
          // build (1024) + o HEADROOM da produção (limite - uso atual) +
          // margem + staging. MemAvailable já desconta o consumo atual, por
          // isso o limite inteiro da produção não é somado de novo.
          productionLimitMb: plan.productionLimitMb,
          productionContainerName: project.containerName,
          requiredDiskMb: undefined,
          stagingReservationMb: plan.stagingLimitMb,
          log: (message) => this.deployLogger.log("staging-start", context, message),
        });
        if (!hostWait.safe) {
          throw new DeployFailure(
            `O host não ficou com recursos para o build em ${hostWait.waitedSec}s (${hostWait.reason}). ` +
              "A versão em produção não foi tocada - o deploy pode ser tentado de novo mais tarde.",
            false,
          );
        }
        const buildStartedAt = Date.now();
        const stagingLog = await this.orchestrator.deployStaging(deployConfig);
        const buildDurationMs = Date.now() - buildStartedAt;
        // A partir daqui o container de TESTE existe: se algo falhar antes
        // do cleanup, o estado dele é capturado antes de ser removido.
        stagingCreated = true;
        await this.deployJobRepository.save(job.withDurations(buildDurationMs, null));
        this.deployLogger.log("staging-start", context, "build concluído", { buildDurationMs });
        deployRecord = await this.deployRecordRepository.save(
          deployRecord.appendLog(`--- build/staging ---\n${stagingLog}`),
        );

        await this.setStage(job, "staging-health", context);
        // O timeout do staging é configurável POR PROJETO (o default é o de
        // sempre). O da produção não muda.
        const stagingHealthTimeout = decideStagingHealthTimeout({
          overrideSeconds: project.stagingHealthTimeoutSeconds,
          defaultSeconds: DEFAULT_STAGING_HEALTH_TIMEOUT_SECONDS,
        });
        if (stagingHealthTimeout.applied) {
          this.deployLogger.log("staging-health", context, stagingHealthTimeout.note ?? "", {
            timeoutSeconds: stagingHealthTimeout.seconds,
            source: stagingHealthTimeout.source,
          });
        }
        const stagingHealthy = await this.healthChecker.waitUntilHealthy(
          deployConfig.staging.hostPort,
          stagingHealthTimeout.seconds * 1000,
        );
        if (!stagingHealthy) {
          throw new DeployFailure(
            `Container de teste subiu mas não respondeu em ${stagingHealthTimeout.seconds}s. A versão em produção não foi tocada.`,
            false,
          );
        }
      } else {
        await this.setStage(job, "staging-start", context);
        deployRecord = await this.deployRecordRepository.save(
          deployRecord.appendLog("--- deploy direto (sem container de teste, configurado nas Configurações) ---"),
        );
      }

      // ------------------------------------------------------------------
      // 6/7. promote + saúde da produção
      //
      // Modo staging-only: a validação termina no health do container de
      // teste. Nada é promovido, nenhuma imagem do projeto muda e o
      // container de produção não é reiniciado.
      // ------------------------------------------------------------------
      if (!stagingOnly) {
        await this.setStage(job, "promote", context);
        const promoteLog = await this.orchestrator.promote(deployConfig, {
          deployJobId: job.id,
          projectId: project.id,
          containerName: deployConfig.containerName,
          kind: "promote",
          previousImage,
        });
        promoted = true;
        deployRecord = await this.deployRecordRepository.save(
          deployRecord.appendLog(`--- promote ---\n${promoteLog}`),
        );

        await this.setStage(job, "production-health", context);
        const productionHealthy = await this.healthChecker.waitUntilHealthy(
          deployConfig.hostPort,
          HEALTH_CHECK_TIMEOUT_MS,
        );

        if (!productionHealthy) {
          await this.setStage(job, "rollback", context);
          rollbackSucceeded = await this.rollbackIfPossible(deployConfig, previousImage, context);
          await this.deployJobRepository.save(job.withRollback(true, rollbackSucceeded));
          throw new DeployFailure(
            rollbackSucceeded
              ? `A versão nova não respondeu em produção. Rollback executado: a versão anterior está no ar de novo.`
              : `A versão nova não respondeu em produção e o ROLLBACK FALHOU. Ação manual necessária.`,
            !rollbackSucceeded,
          );
        }
      } else {
        this.deployLogger.log(
          "staging-health",
          context,
          "staging-only: promoção pulada - a produção NÃO foi alterada",
          { commit: prepared.sha },
        );
      }

      // ------------------------------------------------------------------
      // 8. sucesso
      // ------------------------------------------------------------------
      // O container de teste é removido ANTES de declarar o deploy
      // concluído: "sucesso" então significa que nada ficou pendente
      // (nem container de teste, nem build rodando).
      await this.setStage(job, "cleanup", context);
      await this.removeStaging(deployConfig, context);
      stagingRemoved = true;

      await this.setStage(job, "complete", context);

      if (stagingOnly) {
        // Validação concluída sem promoção: currentImage/previousImage e o
        // estado do projeto ficam EXATAMENTE como estavam.
        await this.deployRecordRepository.save(deployRecord.withResult("success", null));
        await this.deployJobRepository.save(job.withStatus("succeeded"));
        this.deployLogger.log("complete", context, "staging-only concluído (produção não foi alterada)", {
          image: candidateImage,
        });
        return;
      }

      const deployed = project
        .withDeployment(deployConfig.containerName, deployConfig.hostPort)
        .withImages(candidateImage, previousImage)
        .withLastDeployStatus("succeeded")
        // O projeto saiu do estado "adotado": ele passou por um deploy com a
        // política nova, então o limite efetivo passa a valer como estado
        // atual (e a reconciliação vai confirmar no próximo boot).
        .withRuntimeObservation({
          productionMemoryLimitMb: deployConfig.memoryLimitMb,
          runtimeSnapshot: updateSnapshotMemoryLimit(project.runtimeSnapshot, deployConfig.memoryLimitMb),
          grandfathered: false,
          grandfatheredAt: project.grandfatheredAt,
          runtimeDriftDetected: false,
          runtimeDriftDetails: null,
        });
      await this.repository.save(deployed);
      await this.deployRecordRepository.save(deployRecord.withResult("success", null));
      await this.deployJobRepository.save(job.withStatus("succeeded"));
      this.deployLogger.log("complete", context, "deploy concluído", { image: candidateImage });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const productionAffected =
        error instanceof DeployFailure ? error.productionAffected : promoted && !rollbackSucceeded;

      // A aplicação em produção só é marcada como quebrada quando a nova
      // versão realmente entrou e NÃO deu pra voltar. Falha de staging (ou
      // deploy com rollback bem-sucedido) mantém o runtime como estava -
      // cron, backup e terminal continuam funcionando.
      // staging-only não mexe no estado do projeto: a produção não foi tocada.
      if (!stagingOnly) {
        let current = await this.repository.findById(project.id);
        if (current) {
          if (productionAffected) {
            current = current.withFailedDeployment();
          }
          current = current.withLastDeployStatus(
            rollbackSucceeded ? "rolled-back" : "failed",
          );
          await this.repository.save(current);
        }
      }

      // DIAGNÓSTICO DO STAGING (somente observabilidade): se o container de
      // teste chegou a existir, captura estado + últimos logs ANTES do
      // cleanup do finally. Best-effort: nunca substitui a causa original
      // nem impede a remoção do container.
      if (deployConfig && stagingCreated && !stagingRemoved) {
        const diagnostics = await this.captureStagingDiagnostics(deployConfig, context);
        if (diagnostics) {
          deployRecord = deployRecord.appendLog(diagnostics);
        }
      }

      await this.deployRecordRepository.save(deployRecord.withResult("failed", message));
      const jobNow = (await this.deployJobRepository.findById(job.id)) ?? job;
      await this.deployJobRepository.save(
        jobNow.withError(message).withStatus(rollbackSucceeded ? "failed" : "failed"),
      );
      this.deployLogger.error(
        jobNow.stage ?? "unknown",
        { ...context, commitSha: jobNow.commitSha },
        `deploy falhou: ${message}`,
        { productionAffected, rollbackSucceeded },
      );
      throw error;
    } finally {
      // SEMPRE remove a instância de teste - sucesso, falha ou exceção.
      if (deployConfig && !stagingRemoved) {
        await this.removeStagingIgnoringErrors(deployConfig, context);
      }
      // Imagens do projeto que não são a atual nem a anterior podem sair.
      if (deployConfig?.imageName) {
        const protectedImages = [project.currentImage, project.previousImage, candidateImage].filter(
          (image): image is string => Boolean(image),
        );
        try {
          const removed = await this.orchestrator.pruneProjectImages({
            imageName: deployConfig.imageName,
            protectedImages,
          });
          if (removed) {
            this.deployLogger.log("cleanup", context, `imagens antigas removidas: ${removed}`);
          }
        } catch (error) {
          this.logger.warn(`Falha ao limpar imagens antigas: ${(error as Error).message}`);
        }
      }

      // Cache de build + imagens dangling: SEMPRE depois do deploy (sucesso
      // ou falha), com checagem de concorrência feita AGORA. Nunca altera o
      // resultado original do job (método trata os próprios erros).
      await this.cleanupBuildCache(job, context);
    }
  }

  /**
   * Limpeza do cache de build/imagens dangling APÓS o deploy.
   *
   * POR QUE AQUI (e não só no promote): um staging que falha nunca promove,
   * então o cache daquele build ficava preso para sempre. O `finally` cobre
   * sucesso, falha de staging, falha de promoção e rollback.
   *
   * CONCORRÊNCIA VERIFICADA NO MOMENTO DA EXECUÇÃO (não no início do deploy):
   *  1. este processo precisa ser o dono do lock do worker de deploy;
   *  2. nenhum self-update/rollout do Core pode estar em andamento;
   *  3. nenhum OUTRO job de deploy pode estar em execução.
   *
   * Se qualquer condição falhar, a limpeza é RECUSADA e registrada. Erros
   * da própria limpeza também são registrados e nunca propagam (estamos no
   * finally do deploy).
   */
  private async cleanupBuildCache(
    job: DeployJob,
    context: { deployJobId: string; projectId: string; commitSha: string | null },
  ): Promise<void> {
    try {
      const reasons: string[] = [];

      if (this.deployLock && !this.deployLock.isHeldByMe()) {
        reasons.push("lock do worker de deploy não pertence a este processo");
      }

      const selfUpdate = this.selfUpdateState ?? defaultSelfUpdateState;
      if (selfUpdate.isRunning()) {
        reasons.push("self-update do Korrelo em andamento");
      }

      const running = await this.deployJobRepository.findAllByStatus("running");
      const others = running.filter((other) => other.id !== job.id);
      if (others.length > 0) {
        reasons.push(`outro deploy em andamento (${others.map((other) => other.id).join(", ")})`);
      }

      if (reasons.length > 0) {
        this.deployLogger.warn(
          "cleanup",
          context,
          `limpeza do cache de build recusada: ${reasons.join("; ")}`,
        );
        return;
      }

      const result = await this.orchestrator.pruneUnusedBuildArtifacts();
      const imageLine = result.imagePrune.ok
        ? "imagens dangling: ok"
        : `imagens dangling: FALHOU (${result.imagePrune.error ?? "erro desconhecido"})`;
      const builderLine = result.builderPrune.ok
        ? `cache BuildKit: ok (reserva ${result.reservedSpace})`
        : `cache BuildKit: FALHOU (${result.builderPrune.error ?? "erro desconhecido"})`;

      if (result.imagePrune.ok && result.builderPrune.ok) {
        this.deployLogger.log("cleanup", context, `limpeza de cache concluída - ${imageLine}; ${builderLine}`);
      } else {
        this.deployLogger.warn("cleanup", context, `limpeza de cache parcial - ${imageLine}; ${builderLine}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deployLogger.warn("cleanup", context, `falha ao limpar cache de build: ${message}`);
    }
  }

  /**
   * Rollback: volta a produção pra imagem anterior.
   *
   * Só mexe na APLICAÇÃO (container). Volume e banco ficam intactos - se o
   * deploy tiver um migration incompatível, o rollback de aplicação pode
   * não ser suficiente (e isso é registrado no log).
   */
  private async rollbackIfPossible(
    config: DeployConfig,
    previousImage: string | null,
    context: { deployJobId: string; projectId: string; commitSha: string | null },
  ): Promise<boolean> {
    if (!previousImage) {
      this.deployLogger.warn(
        "rollback",
        context,
        "sem imagem anterior registrada - rollback não é possível (deploy de primeira versão)",
      );
      return false;
    }

    try {
      const log = await this.orchestrator.rollback(config, previousImage, {
        deployJobId: context.deployJobId,
        projectId: context.projectId,
        containerName: config.containerName,
        kind: "rollback",
        previousImage,
      });
      this.deployLogger.log("rollback", context, "imagem anterior restaurada", { previousImage });
      if (log) {
        this.logger.debug(log);
      }
      const healthy = await this.healthChecker.waitUntilHealthy(config.hostPort, HEALTH_CHECK_TIMEOUT_MS);
      if (!healthy) {
        this.deployLogger.error("rollback", context, "a versão anterior também não respondeu");
      }
      return healthy;
    } catch (error) {
      this.deployLogger.error("rollback", context, `falha no rollback: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Escreve os arquivos de ambiente do projeto FORA do diretório do projeto,
   * para que nunca entrem no contexto de build (e nem numa camada de imagem).
   *
   * DOIS arquivos, com papéis diferentes:
   *
   * - `.env.korrelo`          -> produção E staging (env comum);
   * - `.env.korrelo.staging`  -> SÓ o serviço `app_staging` (segundo env_file).
   *
   * As variáveis `KORRELO_STAGING_*` são retiradas do arquivo comum (a
   * produção nunca as vê) e escritas no arquivo de staging com o prefixo
   * removido (`KORRELO_STAGING_FOO=1` chega ao teste como `FOO=1`).
   *
   * `KORRELO_DEPLOY_ENV` é RESERVADA: se o projeto tentar defini-la, o
   * deploy é recusado em vez de sobrescrever o valor em silêncio.
   */
  private async writeEnvFile(
    project: Project,
  ): Promise<{ envFilePath: string; stagingEnvFilePath: string | null }> {
    const secretsDir = getProjectSecretsDir(project.id);
    const secretsPath = getProjectSecretsPath(project.id);
    const stagingSecretsPath = getProjectStagingSecretsPath(project.id);
    await fs.mkdir(secretsDir, { recursive: true });

    const envVars = await this.envVarRepository.findByProjectId(project.id);

    if (
      envVars.some(
        (v) =>
          v.key === STAGING_DEPLOY_ENV_VAR ||
          v.key === `${STAGING_ENV_PREFIX}${STAGING_DEPLOY_ENV_VAR}`,
      )
    ) {
      throw new DeployFailure(
        `A variável ${STAGING_DEPLOY_ENV_VAR} é reservada pelo Korrelo e não pode ser ` +
          "definida nas variáveis de ambiente do projeto (nem direto, nem via prefixo " +
          `${STAGING_ENV_PREFIX}). Ela identifica o container de teste e nunca existe em ` +
          "produção. Remova/renomeie essa variável para o deploy continuar.",
        false,
      );
    }

    const stagingVars = envVars
      .filter((v) => v.key.startsWith(STAGING_ENV_PREFIX))
      .map((v) => ({ key: v.key.slice(STAGING_ENV_PREFIX.length), value: v.value }))
      .filter((v) => v.key.length > 0);
    const productionVars = envVars.filter((v) => !v.key.startsWith(STAGING_ENV_PREFIX));

    const envFileContent = productionVars.map((v) => `${v.key}=${v.value}`).join("\n") + "\n";
    await fs.writeFile(secretsPath, envFileContent, "utf-8");

    let stagingEnvFilePath: string | null = null;
    if (stagingVars.length > 0) {
      const stagingContent = stagingVars.map((v) => `${v.key}=${v.value}`).join("\n") + "\n";
      await fs.writeFile(stagingSecretsPath, stagingContent, "utf-8");
      stagingEnvFilePath = stagingSecretsPath;
    } else {
      // Sem variáveis de staging: remove um arquivo antigo para não vazar
      // valor de um deploy anterior.
      await fs.rm(stagingSecretsPath, { force: true });
    }

    // Só o dono do Core lê os segredos do projeto.
    for (const filePath of [secretsPath, stagingEnvFilePath].filter(Boolean) as string[]) {
      try {
        await fs.chmod(filePath, 0o600);
      } catch {
        // best effort
      }
    }

    // Remove a cópia antiga (dentro do workspace) se existir: ela ficaria
    // no contexto de build.
    const legacyPath = path.join(getProjectWorkspacePath(project.id), ".env.korrelo");
    try {
      await fs.rm(legacyPath, { force: true });
    } catch {
      // best effort
    }

    return { envFilePath: secretsPath, stagingEnvFilePath };
  }

  /**
   * Estimativa de memória do deploy, SEM efeito colateral.
   *
   * Usada pelo worker ANTES do preflight: é o que permite dizer "esse deploy
   * precisa de X MB de container de teste" e bloquear o build quando a VPS
   * não tem folga - sem reduzir, parar ou reiniciar a produção.
   */
  async estimateMemoryReservation(projectId: string): Promise<{
    productionLimitMb: number;
    stagingLimitMb: number;
    databaseBudgetTotalMb: number;
  }> {
    const project = await this.repository.findById(projectId);
    if (!project) {
      return { productionLimitMb: 0, stagingLimitMb: 0, databaseBudgetTotalMb: 0 };
    }
    const plan = await this.computeMemoryPlan(project);
    return {
      productionLimitMb: plan.productionLimitMb,
      stagingLimitMb: plan.stagingLimitMb,
      databaseBudgetTotalMb: plan.databaseBudgetTotalMb,
    };
  }

  /**
   * Orçamento de memória do projeto: app + banco + staging dividem a MESMA
   * fatia da memória disponível (nada mais recebe "a RAM inteira" por fora
   * do orçamento) E o limite de produção de um projeto que já roda é
   * preservado (grandfathering).
   */
  private async computeMemoryPlan(project: Project): Promise<DeploymentMemoryPlan> {
    const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
    const all = await this.repository.findAll();
    const activeIds = new Set(
      all.filter((p) => p.status === "running" || p.id === project.id).map((p) => p.id),
    );
    const databases = await this.managedDatabaseRepository.findAllByProjectId(project.id);

    return computeDeploymentMemoryPlan({
      totalMemMb,
      activeProjects: activeIds.size,
      // O limite OBSERVADO no Docker é a fonte da verdade do runtime atual.
      observedProductionLimitMb: project.productionMemoryLimitMb,
      adminLimitMb: project.memoryLimitMb,
      isRunning: project.status === "running",
      isGrandfathered: project.grandfathered,
      adminReductionApproved: project.memoryLimitReductionApproved,
      databases: databases
        .filter((db) => db.type !== "custom")
        .map((db) => ({
          type: db.type as "postgres" | "redis" | "mongodb",
          observedLimitMb: db.memoryLimitMb,
        })),
      // Configuração de staging DESTE projeto (null = automático). Só o
      // container de TESTE usa isso - produção e banco não são tocados.
      stagingOverrideLimitMb: project.stagingMemoryLimitMb,
    });
  }

  private parseHealthcheckConfig(project: Project): HealthcheckConfig | null {
    if (!project.healthcheckConfig) return null;
    try {
      const parsed = JSON.parse(project.healthcheckConfig) as Partial<HealthcheckConfig>;
      return {
        enabled: parsed.enabled === true,
        path: parsed.path ?? "/",
        intervalSeconds: clampInt(parsed.intervalSeconds, 30, 5, 300),
        timeoutSeconds: clampInt(parsed.timeoutSeconds, 5, 1, 60),
        retries: clampInt(parsed.retries, 3, 1, 10),
        // start_period generoso: app que demora pra subir não entra em
        // loop de restart por healthcheck.
        startPeriodSeconds: clampInt(parsed.startPeriodSeconds, 120, 0, 600),
      };
    } catch {
      return null;
    }
  }

  /**
   * Teto de swap do container. NADA é aplicado por padrão (mantém o
   * comportamento atual do Docker). Pra proibir swap no container, defina
   * KORRELO_MEMSWAP_LIMIT_MB (igual ao mem_limit do container).
   */
  private parseMemswapLimitMb(): number | null {
    const raw = process.env.KORRELO_MEMSWAP_LIMIT_MB;
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  private async setStage(
    job: DeployJob,
    stage: DeployJobStage,
    context: { deployJobId: string; projectId: string; commitSha: string | null },
  ): Promise<void> {
    await this.deployJobRepository.save(job.withStage(stage));
    this.deployLogger.log(stage, context, "etapa iniciada");
  }

  /**
   * Captura estado + últimos logs do container de TESTE antes do cleanup.
   *
   * SOMENTE OBSERVABILIDADE. Nunca toca na produção (recebe apenas
   * `config.staging.containerName`), nunca lança e nunca substitui o erro
   * original do deploy: qualquer falha vira uma linha sanitizada no log.
   */
  private async captureStagingDiagnostics(
    config: DeployConfig,
    context: { deployJobId: string; projectId: string; commitSha: string | null },
  ): Promise<string | null> {
    const containerName = config.staging?.containerName;
    if (!containerName) return null;

    try {
      const collector = this.stagingDiagnostics ?? new StagingDiagnosticsCollector();
      const capture = await collector.collect(containerName);
      this.deployLogger.warn("staging-health", context, "diagnóstico do staging capturado antes do cleanup", {
        status: capture.state?.status ?? null,
        exitCode: capture.state?.exitCode ?? null,
        oomKilled: capture.state?.oomKilled ?? null,
        restartCount: capture.state?.restartCount ?? null,
        logsCaptured: capture.logs !== null,
      });
      return formatStagingDiagnostics(capture);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Diagnóstico do staging indisponível: ${sanitizeDiagnosticText(detail)}`);
      return null;
    }
  }

  private async removeStagingIgnoringErrors(
    config: DeployConfig,
    context: { deployJobId: string; projectId: string; commitSha: string | null },
  ): Promise<void> {
    try {
      await this.removeStaging(config, context);
    } catch (error) {
      // A limpeza do staging também roda no startup (recuperação de
      // órfãos), então uma falha aqui não é fatal.
      this.deployLogger.warn("cleanup", context, `falha ao remover o container de teste: ${(error as Error).message}`);
    }
  }

  /** Remove o container de teste (erro é logado, não propagado). */
  private async removeStaging(
    config: DeployConfig,
    context: { deployJobId: string; projectId: string; commitSha: string | null },
  ): Promise<void> {
    await this.orchestrator.removeStaging(config);
    this.deployLogger.log("cleanup", context, "container de teste removido");
  }

  private async resolveGithubAccessToken(): Promise<string | undefined> {
    const installation = await this.githubInstallationRepository.findLatest();
    if (!installation) return undefined;

    const { token } = await this.githubAppClient.createInstallationToken(installation.installationId);
    return token;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Atualiza o limite de memória dentro do snapshot de runtime (o snapshot
 * descreve o container que acabou de ser recriado pelo deploy).
 */
function updateSnapshotMemoryLimit(snapshot: string | null, memoryLimitMb: number): string | null {
  if (!snapshot) return null;
  try {
    const parsed = JSON.parse(snapshot) as Record<string, unknown>;
    parsed.memoryLimitMb = memoryLimitMb;
    return JSON.stringify(parsed);
  } catch {
    return snapshot;
  }
}
