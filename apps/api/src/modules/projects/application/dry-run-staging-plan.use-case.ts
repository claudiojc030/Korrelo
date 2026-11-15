import { Inject, Injectable, Optional } from "@nestjs/common";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import {
  STAGING_CONFIG_LOADER,
  type StagingConfigLoader,
} from "../domain/persisted-staging-config";
import {
  STAGING_CONTEXT_COLLECTOR,
  type StagingContextCollector,
  type StagingDryRunInput,
  type StagingDryRunResult,
} from "../domain/staging-context";
import { planStaging } from "../domain/staging-planner";

const DEFAULT_MAX_CONCURRENT_ENVIRONMENTS = 1;
const DEFAULT_MAX_TTL_MINUTES = 240;

/**
 * DRY-RUN INTERNO DO STAGING ISOLADO (P1A).
 *
 * - recebe configuração explícita;
 * - valida o projeto na base;
 * - coleta contexto por adaptadores SOMENTE LEITURA;
 * - chama o planejador puro do P0;
 * - não executa Compose, não cria env, não abre porta, não cria container.
 *
 * Não é exposto por controller nesta fase. Configuração ausente continua
 * significando fluxo legado, sem sequer consultar Docker ou recursos do host.
 */
@Injectable()
export class DryRunStagingPlanUseCase {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    @Inject(STAGING_CONTEXT_COLLECTOR) private readonly contextCollector: StagingContextCollector,
    @Optional()
    @Inject(STAGING_CONFIG_LOADER)
    private readonly configLoader: StagingConfigLoader | null = null,
  ) {}

  async execute(input: StagingDryRunInput): Promise<StagingDryRunResult> {
    const projectId = String(input?.projectId ?? "").trim();
    let config = input?.config ?? null;
    let dependencies = input?.dependencies ?? [];
    const requestedMode = config?.mode ?? "legacy";

    if (!projectId) {
      return failure("", requestedMode, "STAGING_PROJECT_ID_REQUIRED", "projectId", "projectId é obrigatório.");
    }

    let project;
    try {
      project = await this.projectRepository.findById(projectId);
    } catch {
      return failure(
        projectId,
        requestedMode,
        "STAGING_CONTEXT_UNAVAILABLE",
        "project",
        "Não foi possível ler o projeto na base; dry-run recusado.",
      );
    }
    if (!project) {
      return failure(
        projectId,
        requestedMode,
        "STAGING_PROJECT_NOT_FOUND",
        "projectId",
        `Projeto ${projectId} não encontrado.`,
      );
    }

    // Configuração persistida é OPCIONAL e só é lida quando o chamador
    // interno pede explicitamente. Sem isso, continua legado.
    if (!config && input.loadPersistedConfig === true) {
      if (!this.configLoader) {
        return failure(
          projectId,
          "isolated",
          "STAGING_CONFIG_LOADER_UNAVAILABLE",
          "config",
          "Carregador de configuração persistida não está disponível; dry-run recusado.",
        );
      }
      let loaded;
      try {
        loaded = await this.configLoader.load(projectId);
      } catch {
        return failure(
          projectId,
          "isolated",
          "STAGING_CONFIG_UNAVAILABLE",
          "config",
          "Falha ao carregar a configuração persistida; dry-run recusado.",
        );
      }
      if (!loaded.ok) {
        return {
          projectId,
          ok: false,
          mode: "isolated",
          legacy: false,
          plan: null,
          issues: loaded.issues,
          contextWarnings: [],
        };
      }
      if (!loaded.legacy && loaded.config) {
        config = loaded.config;
        dependencies = loaded.dependencies;
      }
    }

    // Compatibilidade absoluta: legado não exige host, Docker ou contexto.
    if (!config || config.mode === "legacy") {
      const validation = planStaging({
        projectId,
        runId: input.runId ?? `dry-run-${projectId}`,
        config,
      });
      return {
        projectId,
        ok: validation.ok,
        mode: validation.mode,
        legacy: validation.legacy,
        plan: validation.plan,
        issues: validation.issues,
        contextWarnings: [],
      };
    }

    // Config inválida/desconhecida não deve consultar Docker.
    if (config.mode !== "isolated") {
      const validation = planStaging({
        projectId,
        runId: input.runId ?? `dry-run-${projectId}`,
        config,
      });
      return {
        projectId,
        ok: validation.ok,
        mode: validation.mode,
        legacy: validation.legacy,
        plan: validation.plan,
        issues: validation.issues,
        contextWarnings: [],
      };
    }

    let collection;
    try {
      collection = await this.contextCollector.collect({
        projectId,
        portCandidates: input.portCandidates ?? [],
        maxConcurrentEnvironments:
          input.maxConcurrentEnvironments ?? DEFAULT_MAX_CONCURRENT_ENVIRONMENTS,
        maxTtlMinutes: input.maxTtlMinutes ?? DEFAULT_MAX_TTL_MINUTES,
      });
    } catch {
      return failure(
        projectId,
        "isolated",
        "STAGING_CONTEXT_UNAVAILABLE",
        "context",
        "Falha ao coletar contexto de staging; dry-run recusado sem fallback.",
      );
    }

    if (!collection.ok || !collection.snapshot) {
      return {
        projectId,
        ok: false,
        mode: "isolated",
        legacy: false,
        plan: null,
        issues: collection.issues,
        contextWarnings: [],
      };
    }

    const validation = (() => {
      try {
        return planStaging({
          projectId,
          runId: input.runId ?? `dry-run-${projectId}`,
          config,
          dependencies,
          production: collection.snapshot.production,
          host: collection.snapshot.host,
          authorizedBindMounts: input.authorizedBindMounts,
        });
      } catch {
        return null;
      }
    })();

    if (!validation) {
      return failure(
        projectId,
        "isolated",
        "STAGING_VALIDATION_FAILED",
        "plan",
        "O planejador recusou os dados de contexto; dry-run encerrado sem fallback.",
      );
    }

    return {
      projectId,
      ok: validation.ok,
      mode: validation.mode,
      legacy: validation.legacy,
      plan: validation.plan,
      issues: validation.issues,
      contextWarnings: collection.snapshot.warnings,
    };
  }
}

function failure(
  projectId: string,
  mode: "legacy" | "isolated",
  code: string,
  field: string,
  message: string,
): StagingDryRunResult {
  return {
    projectId,
    ok: false,
    mode,
    legacy: mode === "legacy",
    plan: null,
    issues: [{ code, field, message }],
    contextWarnings: [],
  };
}
