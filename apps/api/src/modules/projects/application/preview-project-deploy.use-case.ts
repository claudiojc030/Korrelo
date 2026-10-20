import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from "@nestjs/common";
import * as os from "node:os";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { MANAGED_DATABASE_REPOSITORY, type ManagedDatabaseRepository } from "../domain/managed-database.repository";
import { computeProjectDeploymentPlan } from "../infrastructure/memory-budget";
import { ResourcePreflightService } from "../infrastructure/resource-preflight.service";
import { readHostResources } from "../../../infrastructure/host-resources";
import { sanitizeContainerName } from "../infrastructure/container-name";
import {
  inspectContainerTruth,
  type ContainerInspector,
  type ContainerTruth,
} from "../infrastructure/docker-container-inspector";
import { decideStagingHealthTimeout } from "../domain/staging-config";

/** Token do inspetor de container (injetável nos testes). */
export const CONTAINER_INSPECTOR = Symbol("CONTAINER_INSPECTOR");

/**
 * Timeout (segundos) da espera de health do container de TESTE - o mesmo
 * default que o deploy usa. Configurável por projeto.
 */
const DEFAULT_STAGING_HEALTH_TIMEOUT_SECONDS = 30;

/**
 * DRY-RUN DO DEPLOY DE PROJETO (read-only).
 *
 * Mostra o que UM deploy faria - sem tocar em Docker, sem build, sem
 * escrever nada. É o plano que o operador precisa ver antes de mandar um
 * deploy para produção crítica (Mesatta) numa VPS de 1 vCPU.
 *
 * O que aparece:
 * - projeto, commit atual, commit candidato;
 * - recursos do host (RAM, swap, load, disco, PSI);
 * - imagem/container atual, volumes e networks conhecidos;
 * - limites (produção e staging) e banco gerenciado;
 * - staging planejado (nome, porta, limites);
 * - health planejado e promoção planejada;
 * - se há rollback disponível (imagem anterior).
 */
@Injectable()
export class PreviewProjectDeployUseCase {
  private readonly logger = new Logger(PreviewProjectDeployUseCase.name);

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly repository: ProjectRepository,
    @Inject(MANAGED_DATABASE_REPOSITORY) private readonly databases: ManagedDatabaseRepository,
    private readonly preflight: ResourcePreflightService,
    @Optional()
    @Inject(CONTAINER_INSPECTOR)
    private readonly containerInspector?: ContainerInspector,
  ) {}

  async execute(projectId: string, options: { commit?: string | null; branch?: string | null } = {}) {
    const project = await this.repository.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Projeto ${projectId} não encontrado`);
    }
    if (!project.detectedStack) {
      throw new BadRequestException(
        "Este projeto ainda não tem stack detectada - rode /detect-stack antes do deploy.",
      );
    }

    const stack = JSON.parse(project.detectedStack) as { language?: string; recommendedPort?: number };
    const managedDatabases = await this.databases.findAllByProjectId(project.id);
    const allProjects = await this.repository.findAll();
    const activeIds = new Set(
      allProjects
        .filter((item) => item.status === "running" || item.id === project.id)
        .map((item) => item.id),
    );
    const plan = computeProjectDeploymentPlan({
      totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
      activeProjects: activeIds.size,
      observedProductionLimitMb: project.productionMemoryLimitMb,
      adminLimitMb: project.memoryLimitMb,
      isRunning: project.status === "running",
      isGrandfathered: project.grandfathered,
      adminReductionApproved: project.memoryLimitReductionApproved,
      databases: managedDatabases
        .filter((db) => db.type !== "custom")
        .map((db) => ({
          type: db.type as "postgres" | "redis" | "mongodb",
          observedLimitMb: db.memoryLimitMb,
        })),
      // Configuração de staging DESTE projeto (null = automático). Só o
      // container de TESTE usa isso - produção e banco não são tocados.
      stagingOverrideLimitMb: project.stagingMemoryLimitMb,
    });
    const hostResources = await readHostResources({ measureSwapActivity: false });
    const preflight = await this.preflight.check({
      requiredMemoryMb: plan.productionLimitMb,
      requiredDiskMb: undefined,
      stagingReservationMb: plan.stagingLimitMb,
      productionReservedMb: 0,
      dockerReachable: true,
    });

    const containerName = sanitizeContainerName(project.id, project.name);
    const candidateImage = options.commit
      ? `${containerName}:commit-${options.commit.slice(0, 12)}`
      : null;

    // Verdade do Docker (leitura pura). Sem Docker não há snapshot real: o
    // dry-run AVISA/falha explicitamente em vez de inventar estado a partir
    // do banco do Core.
    const currentContainer: ContainerTruth | null = await (
      this.containerInspector ?? inspectContainerTruth
    )(containerName);
    if (!currentContainer) {
      throw new ServiceUnavailableException(
        "Docker indisponível: não foi possível ler o estado real do container de produção " +
          `(${containerName}). O dry-run não inventa estado - suba o Docker e rode de novo.`,
      );
    }

    const warnings: string[] = [];
    if (managedDatabases.length > 0) {
      warnings.push(
        "O container de TESTE (staging) usa o MESMO env_file e a MESMA rede do app de produção: " +
          "ele conecta no banco de produção. O Korrelo NÃO roda migration nenhuma nesse banco e " +
          "sobe o staging com --no-deps (nunca inicia/recria o banco), mas o PRÓPRIO app pode " +
          "rodar migrations/trabalho de fundo ao subir - isso não é controlável pelo Korrelo. " +
          "Use envs de staging (prefixo STAGING_) para desativar workers/cron no container de teste.",
      );
    }
    warnings.push(
      "O container de TESTE compartilha o volume 'uploads-data' com a produção: " +
        "o staging pode escrever no volume de uploads em produção.",
    );

    // A configuração de staging deste projeto (o que seria aplicado no
    // container de TESTE) - o mesmo cálculo que o deploy faz.
    const stagingHealthTimeout = decideStagingHealthTimeout({
      overrideSeconds: project.stagingHealthTimeoutSeconds,
      defaultSeconds: DEFAULT_STAGING_HEALTH_TIMEOUT_SECONDS,
    });
    if (plan.stagingLimitNote) {
      warnings.push(plan.stagingLimitNote);
    }
    if (stagingHealthTimeout.note) {
      warnings.push(stagingHealthTimeout.note);
    }

    return {
      dryRun: true,
      project: {
        id: project.id,
        name: project.name,
        language: stack.language ?? null,
        assignedPort: project.assignedPort ?? stack.recommendedPort ?? null,
      },
      current: {
        image: project.currentImage,
        previousImage: project.previousImage,
        containerName,
        productionMemoryLimitMb: project.productionMemoryLimitMb,
        runtimeSnapshot: project.runtimeSnapshot,
        // Verdade do Docker (lida agora, somente leitura).
        container: currentContainer,
      },
      candidate: {
        commit: options.commit ?? null,
        branch: options.branch ?? null,
        image: candidateImage,
      },
      resources: {
        memAvailableMb: hostResources.memAvailableMb,
        memTotalMb: hostResources.memTotalMb,
        swapUsedMb: hostResources.swapUsedMb,
        swapTotalMb: hostResources.swapTotalMb,
        load1: hostResources.load1,
        diskAvailableMb: hostResources.diskAvailableMb,
        memoryPressure: hostResources.memoryPressure,
        swapActivity: hostResources.swapActivity,
        safeToBuild: preflight.ok,
        reason: preflight.reason,
        availableForBuildMb: preflight.metrics.availableForBuildMb,
      },
      limits: {
        productionLimitMb: plan.productionLimitMb,
        stagingLimitMb: plan.stagingLimitMb,
        databaseBudgetTotalMb: plan.databaseBudgetTotalMb,
        grandfathered: plan.effective.grandfathered,
      },
      databases: managedDatabases.map((db) => ({
        type: db.type,
        serviceName: db.serviceName,
        persistent: db.persistent,
        memoryLimitMb: db.memoryLimitMb,
      })),
      staging: {
        containerName: `${containerName}-staging`,
        hostPort: (project.assignedPort ?? stack.recommendedPort ?? 3000) + 1,
        memoryLimitMb: plan.stagingLimitMb,
        // De onde veio o limite: configuração do projeto ou rateio automático.
        memoryLimitSource: plan.stagingLimitSource,
        memoryLimitApplied: plan.stagingLimitApplied,
        // Timeout da espera de health do container de TESTE.
        healthTimeoutSeconds: stagingHealthTimeout.seconds,
        healthTimeoutSource: stagingHealthTimeout.source,
        healthTimeoutApplied: stagingHealthTimeout.applied,
        isolated: true,
        // O staging sobe com --no-deps: o Korrelo NUNCA inicia nem recria o
        // banco/volume de produção.
        noDeps: true,
        sharesProductionDatabase: managedDatabases.length > 0,
        sharesProductionVolume: true,
        note: "o container de teste roda em paralelo à produção; volumes e bancos de produção não são tocados",
      },
      warnings,
      health: {
        configured: Boolean(project.healthcheckConfig),
        timeoutSeconds: 30,
        note: "o candidato só é promovido depois de responder no health",
      },
      promotion: {
        strategy: "recreate do container de produção com a imagem versionada (--no-deps)",
        previousImageAvailable: Boolean(project.previousImage),
      },
      rollback: {
        available: Boolean(project.previousImage),
        image: project.previousImage,
        note: "o rollback reaproveita a imagem anterior (sem rebuild) e não toca volumes nem bancos",
      },
    };
  }
}
