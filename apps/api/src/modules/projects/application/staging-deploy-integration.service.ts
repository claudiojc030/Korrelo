import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  STAGING_CONFIG_LOADER,
  type StagingConfigLoader,
} from "../domain/persisted-staging-config";
import {
  STAGING_CONTEXT_COLLECTOR,
  type StagingContextCollector,
} from "../domain/staging-context";
import type { StagingCapacityPolicy } from "../domain/staging-capacity";
import type { StagingExecutionRequest } from "../domain/staging-execution";
import { planStaging } from "../domain/staging-planner";
import { StagingExecutionService } from "./staging-execution.service";

/**
 * Integração OPCIONAL do staging isolado com o fluxo de deploy.
 *
 * Garantias:
 * - ausência de configuração persistida = `legacy` e nenhum efeito;
 * - configuração isolada sem flag global = falha fechada, nunca fallback;
 * - nenhum rebuild: a imagem precisa existir e ser verificada pelo executor;
 * - dependências/segredos de staging ainda NÃO são suportados no deploy (o
 *   Compose isolado deles não recebe env de staging); nesse caso falha
 *   fechada em vez de reutilizar produção.
 */
export type StagingDeployMode = "legacy" | "isolated";

export interface StagingDeployPrepareInput {
  projectId: string;
  deployJobId: string;
  commitSha: string;
  imageReference: string;
  containerPort: number;
  portCandidates: number[];
  healthPath?: string | null;
  healthRequire2xx?: boolean;
}

export interface StagingDeployPrepareResult {
  mode: StagingDeployMode;
  ok: boolean;
  legacy: boolean;
  issues: string[];
  runId: string | null;
  composeHash: string | null;
}

const DEPLOY_CAPACITY_POLICY: StagingCapacityPolicy = {
  maxConcurrentEnvironments: 4,
  maxTtlMinutes: 240,
  productionReservedMemoryMb: 0,
  productionReservedCpu: 0,
  productionReservedDiskMb: 0,
  safetyMemoryMb: 0,
  safetyCpu: 0,
  safetyDiskMb: 0,
};

@Injectable()
export class StagingDeployIntegrationService {
  constructor(
    @Inject(STAGING_CONFIG_LOADER) private readonly configLoader: StagingConfigLoader,
    @Inject(STAGING_CONTEXT_COLLECTOR) private readonly contextCollector: StagingContextCollector,
    private readonly executor: StagingExecutionService,
    @Optional() private readonly enabled: boolean = process.env.KORRELO_STAGING_ISOLATED_EXECUTION === "true",
  ) {}

  async prepare(input: StagingDeployPrepareInput): Promise<StagingDeployPrepareResult> {
    if (!isCompleteCommit(input.commitSha)) {
      return isolatedFailure("commit SHA completo é obrigatório para staging isolado");
    }

    let loaded;
    try {
      loaded = await this.configLoader.load(input.projectId);
    } catch {
      return isolatedFailure("falha ao carregar configuração de staging; deploy bloqueado sem fallback");
    }
    if (loaded.legacy) {
      return { mode: "legacy", ok: true, legacy: true, issues: [], runId: null, composeHash: null };
    }
    if (!loaded.ok || !loaded.config) {
      return isolatedFailure(
        ...loaded.issues.map((issue) => issue.message || "configuração de staging inválida"),
      );
    }
    if (loaded.config.mode !== "isolated") {
      return isolatedFailure("modo de staging configurado é inválido");
    }
    if (!this.enabled) {
      return isolatedFailure(
        "staging isolado configurado, mas KORRELO_STAGING_ISOLATED_EXECUTION não está habilitado",
      );
    }
    if (loaded.config.env.length > 0) {
      return isolatedFailure(
        "staging isolado com segredos próprios ainda não é suportado no fluxo de deploy",
      );
    }
    if (loaded.dependencies.length > 0) {
      return isolatedFailure(
        "staging isolado com dependências (bancos) ainda não é suportado no fluxo de deploy",
      );
    }
    if (!input.imageReference.trim()) {
      return isolatedFailure("imagem pré-construída é obrigatória no staging isolado");
    }

    const runId = `job-${input.deployJobId}`;
    const maxTtl = Math.min(loaded.config.ttlMinutes, DEPLOY_CAPACITY_POLICY.maxTtlMinutes);
    let collection;
    try {
      collection = await this.contextCollector.collect({
        projectId: input.projectId,
        portCandidates: input.portCandidates,
        maxConcurrentEnvironments: DEPLOY_CAPACITY_POLICY.maxConcurrentEnvironments,
        maxTtlMinutes: maxTtl,
      });
    } catch {
      return isolatedFailure("falha ao coletar contexto de staging; deploy bloqueado sem fallback");
    }
    if (!collection.ok || !collection.snapshot) {
      return isolatedFailure(
        ...collection.issues.map((issue) => issue.message || "contexto de staging indisponível"),
      );
    }

    const validation = planStaging({
      projectId: input.projectId,
      runId,
      config: loaded.config,
      dependencies: [],
      production: collection.snapshot.production,
      host: collection.snapshot.host,
    });
    if (!validation.ok || !validation.plan) {
      return isolatedFailure(
        ...validation.issues.map((issue) => issue.message || "plano de staging inválido"),
      );
    }

    const request: StagingExecutionRequest = {
      plan: validation.plan,
      commitSha: input.commitSha.toLowerCase(),
      mode: "prebuilt",
      compose: {
        containerPort: input.containerPort,
        pidsLimit: 128,
        imageReference: input.imageReference.trim(),
        healthcheck: null,
      },
      imageIdentity: {
        projectId: input.projectId,
        commitSha: input.commitSha.toLowerCase(),
        imageReference: input.imageReference.trim(),
        observed: { imageId: "", repoDigests: [], labels: {} },
      },
      deployJobId: input.deployJobId,
      ownerId: input.deployJobId,
      portCandidates: input.portCandidates,
      ttlMinutes: maxTtl,
      policy: DEPLOY_CAPACITY_POLICY,
      app: loaded.config.app,
      dependencies: [],
    };
    // A sonda HTTP do contrato de deploy roda depois do container ficar
    // saudável; sem healthcheck Docker o estado "Running" sozinho não aprova.
    const httpHealth = input.healthPath
      ? { path: input.healthPath, require2xx: input.healthRequire2xx !== false, containerPort: input.containerPort }
      : null;

    const result = await this.executor.execute(request, httpHealth);
    if (!result.ok) {
      return isolatedFailure(...(result.issues.length > 0 ? result.issues : ["staging isolado falhou"]));
    }
    return {
      mode: "isolated",
      ok: true,
      legacy: false,
      issues: [],
      runId: result.run?.runId ?? validation.plan.runId,
      composeHash: result.composeHash,
    };
  }
}

function isolatedFailure(...issues: string[]): StagingDeployPrepareResult {
  return { mode: "isolated", ok: false, legacy: false, issues, runId: null, composeHash: null };
}

function isCompleteCommit(value: string): boolean {
  return /^[a-f0-9]{40}$/i.test(String(value ?? "").trim());
}
