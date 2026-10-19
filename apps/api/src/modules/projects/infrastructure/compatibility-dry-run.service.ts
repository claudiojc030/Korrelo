import { Inject, Injectable, Logger } from "@nestjs/common";
import * as os from "node:os";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { MANAGED_DATABASE_REPOSITORY, type ManagedDatabaseRepository } from "../domain/managed-database.repository";
import { computeDeploymentMemoryPlan } from "./memory-budget";
import { ResourcePreflightService } from "./resource-preflight.service";
import { RuntimeReconciliationService } from "./runtime-reconciliation.service";

/**
 * DRY-RUN de compatibilidade (Wave 2.1).
 *
 * Mostra o que ACONTECERIA com cada projeto se um deploy fosse feito agora -
 * SEM MEXER EM NADA (nenhum container, volume, rede, porta ou banco é
 * tocado; nenhuma escrita no Docker).
 *
 * É a ferramenta para responder "o que muda pra minha VPS quando eu
 * atualizar o Korrelo?".
 */
export interface ProjectDryRun {
  projectId: string;
  projectName: string;
  status: string;
  /** Limite de produção ATUAL (observado no Docker). */
  currentProductionLimitMb: number | null;
  /** Limite que a fórmula nova calcularia. */
  calculatedNewLimitMb: number;
  /** Limite que seria EFETIVAMENTE usado (o observado, se grandfathered). */
  effectiveLimitMb: number;
  /** De onde veio o limite efetivo. */
  limitSource: string;
  /** true quando o projeto foi adotado (runtime preservado). */
  grandfathered: boolean;
  /** true quando o limite atual seria reduzido (exige confirmação). */
  wouldReduceLimit: boolean;
  requiresExplicitConfirmation: boolean;
  note: string | null;
  /** Bancos: limite atual e o que seria usado. */
  databases: {
    serviceName: string;
    type: string;
    currentLimitMb: number | null;
    effectiveLimitMb: number;
    preserved: boolean;
  }[];
  /** Budget TOTAL de banco do projeto (soma dos limites ≤ este valor). */
  databaseBudgetTotalMb: number;
  /** Divergência entre Core e Docker (Docker é a fonte da verdade). */
  runtimeDriftDetected: boolean;
  runtimeDriftDetails: string[];
  /** true se um deploy seria possível agora. */
  deployPossibleNow: boolean;
  /** Motivo (quando não é possível). */
  reason: string | null;
}

export interface DryRunReport {
  hostTotalMemMb: number;
  hostFreeMemMb: number;
  /** Soma dos limites de produção já em uso (reservado - intocável). */
  productionReservedMb: number;
  generatedAt: string;
  projects: ProjectDryRun[];
  /** Observação geral (ex.: overcommit pré-existente). */
  warnings: string[];
}

@Injectable()
export class CompatibilityDryRunService {
  private readonly logger = new Logger(CompatibilityDryRunService.name);

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    @Inject(MANAGED_DATABASE_REPOSITORY) private readonly managedDatabaseRepository: ManagedDatabaseRepository,
    private readonly reconciliation: RuntimeReconciliationService,
    private readonly preflight: ResourcePreflightService,
  ) {}

  async run(): Promise<DryRunReport> {
    const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
    const freeMemMb = Math.round(os.freemem() / 1024 / 1024);
    const projects = await this.projectRepository.findAll();
    const warnings: string[] = [];

    const activeIds = new Set(
      projects.filter((p) => p.status === "running" || p.grandfathered).map((p) => p.id),
    );

    const reports: ProjectDryRun[] = [];

    for (const project of projects) {
      if (!project.containerName) continue;

      // Leitura AO VIVO do container (read-only). Se o Docker não responder,
      // usa o que o Core já sabe (e sinaliza).
      const live = await this.reconciliation.inspectContainer(project.containerName);
      const currentProductionLimitMb = live?.memoryLimitMb ?? project.productionMemoryLimitMb;

      const databases = await this.managedDatabaseRepository.findAllByProjectId(project.id);
      const managed = databases.filter((db) => db.type !== "custom");

      const plan = computeDeploymentMemoryPlan({
        totalMemMb,
        activeProjects: Math.max(1, activeIds.size),
        observedProductionLimitMb: currentProductionLimitMb,
        adminLimitMb: project.memoryLimitMb,
        isRunning: project.status === "running",
        isGrandfathered: project.grandfathered,
        adminReductionApproved: project.memoryLimitReductionApproved,
        databases: managed.map((db) => ({
          type: db.type as "postgres" | "redis" | "mongodb",
          observedLimitMb: db.memoryLimitMb,
        })),
      });

      // O preflight: dá pra buildar/stagiar AGORA sem ameaçar a produção?
      const preflight = await this.preflight.check({ activeBuilds: 0 });

      const driftDetails = safeParseArray(project.runtimeDriftDetails);

      reports.push({
        projectId: project.id,
        projectName: project.name,
        status: project.status,
        currentProductionLimitMb,
        calculatedNewLimitMb: plan.effective.calculatedLimitMb,
        effectiveLimitMb: plan.productionLimitMb,
        limitSource: plan.effective.source,
        grandfathered: plan.effective.grandfathered,
        wouldReduceLimit:
          currentProductionLimitMb !== null && plan.productionLimitMb < currentProductionLimitMb,
        requiresExplicitConfirmation: plan.requiresExplicitConfirmation,
        note: plan.effective.note,
        databases: managed.map((db) => {
          const budget = plan.databaseLimits.find((l) => l.type === db.type);
          return {
            serviceName: db.serviceName ?? db.type,
            type: db.type,
            currentLimitMb: db.memoryLimitMb,
            effectiveLimitMb: budget?.limitMb ?? 0,
            preserved: budget?.preserved ?? false,
          };
        }),
        databaseBudgetTotalMb: plan.databaseBudgetTotalMb,
        runtimeDriftDetected: project.runtimeDriftDetected,
        runtimeDriftDetails: driftDetails,
        deployPossibleNow: preflight.ok && !plan.requiresExplicitConfirmation,
        reason: plan.requiresExplicitConfirmation
          ? (plan.effective.note ?? "redução de memória exige confirmação explícita")
          : preflight.ok
            ? null
            : preflight.reason,
      });
    }

    const productionReservedMb = reports.reduce(
      (sum, report) => sum + (report.currentProductionLimitMb ?? 0),
      0,
    );

    if (productionReservedMb > totalMemMb) {
      warnings.push(
        `Os containers de produção já reservam ${productionReservedMb} MB numa VPS de ${totalMemMb} MB ` +
          `(overcommit pré-existente: ${productionReservedMb - totalMemMb} MB acima da RAM física). ` +
          "O Korrelo não reduz nada sozinho - isso precisa de decisão do administrador.",
      );
    }

    return {
      hostTotalMemMb: totalMemMb,
      hostFreeMemMb: freeMemMb,
      productionReservedMb,
      generatedAt: new Date().toISOString(),
      projects: reports,
      warnings,
    };
  }
}

function safeParseArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
