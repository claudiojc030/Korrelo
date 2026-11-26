import type { DeployConfig } from "../domain/container-orchestrator";

/**
 * PIPELINE SEQUENCIAL (Smart Deploy V2) — preparação de build e staging.
 *
 * Executa, em ordem e com reavaliação entre as fases:
 *   1. preflight de build (sem reservar staging);
 *   2. build da imagem, sem criar container;
 *   3. verificação de identidade da imagem construída;
 *   4. preflight de staging (build já terminou, memória liberada);
 *   5. subida do staging com `--no-build`;
 *   6. reverificação da imagem antes de devolver o controle.
 *
 * Nunca promove, nunca remove volume, nunca toca no container de produção.
 * A flag que o habilita é lida FORA deste módulo (default desligada).
 */

export interface SequentialPhaseOrchestrator {
  buildCandidate(config: DeployConfig): Promise<string>;
  startStaging(config: DeployConfig): Promise<string>;
  imageId(reference: string): Promise<string | null>;
  containerImageId(containerName: string): Promise<string | null>;
}

export interface SequentialPhasePreflight {
  waitForSafeHost(options: {
    productionLimitMb: number;
    productionContainerName?: string | null;
    requiredMemoryMb?: number;
    requiredDiskMb?: number;
    stagingReservationMb?: number;
    log?: (message: string) => void;
  }): Promise<{ safe: boolean; reason: string | null; waitedSec: number; attempts: number }>;
}

export interface SequentialPrepareInput {
  config: DeployConfig;
  productionLimitMb: number;
  productionContainerName: string | null;
  /** Pico/limite da fase de build (default do preflight quando omitido). */
  buildRequirementMb: number;
  /** Limite do container de staging (vira o requisito da fase). */
  stagingRequirementMb: number;
  log: (message: string) => void;
}

export interface SequentialPrepareResult {
  imageId: string;
  buildLog: string;
  stagingLog: string;
  buildDurationMs: number;
  stagingWaitSec: number;
}

export type SequentialPhaseFailure = "preflight-build" | "build" | "image-missing" | "preflight-staging" | "staging" | "image-changed";

export class SequentialDeployError extends Error {
  constructor(
    readonly phase: SequentialPhaseFailure,
    message: string,
    readonly imageBuilt = false,
    readonly stagingStarted = false,
  ) {
    super(message);
    this.name = "SequentialDeployError";
  }
}

export function sequentialCandidateReference(config: DeployConfig): string | null {
  if (!config.imageName || !config.imageTag) return null;
  return `${config.imageName}:${config.imageTag}`;
}

export class SequentialDeployRunner {
  constructor(
    private readonly orchestrator: SequentialPhaseOrchestrator,
    private readonly preflight: SequentialPhasePreflight,
  ) {}

  async prepare(input: SequentialPrepareInput): Promise<SequentialPrepareResult> {
    const reference = sequentialCandidateReference(input.config);
    if (!reference) {
      throw new SequentialDeployError(
        "build",
        "Imagem/tag do candidato não definidas; o pipeline sequencial foi recusado.",
      );
    }

    // FASE 1 — build. Não reserva staging: ele ainda não existe.
    const buildWait = await this.preflight.waitForSafeHost({
      productionLimitMb: input.productionLimitMb,
      productionContainerName: input.productionContainerName,
      requiredMemoryMb: input.buildRequirementMb,
      stagingReservationMb: 0,
      log: input.log,
    });
    if (!buildWait.safe) {
      throw new SequentialDeployError(
        "preflight-build",
        `Recursos insuficientes para o build (${buildWait.reason ?? "sem folga"}). Produção intocada.`,
      );
    }

    const buildStartedAt = Date.now();
    let buildLog: string;
    try {
      buildLog = await this.orchestrator.buildCandidate(input.config);
    } catch (error) {
      throw new SequentialDeployError(
        "build",
        `Build falhou antes de qualquer container: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const buildDurationMs = Date.now() - buildStartedAt;

    const builtImageId = await this.orchestrator.imageId(reference);
    if (!builtImageId) {
      throw new SequentialDeployError(
        "image-missing",
        "A imagem construída não pôde ser verificada; staging bloqueado.",
        true,
      );
    }

    // FASE 2 — staging. O build terminou; a reserva dele não é mais somada.
    const stagingWait = await this.preflight.waitForSafeHost({
      productionLimitMb: input.productionLimitMb,
      productionContainerName: input.productionContainerName,
      requiredMemoryMb: input.stagingRequirementMb,
      stagingReservationMb: 0,
      log: input.log,
    });
    if (!stagingWait.safe) {
      throw new SequentialDeployError(
        "preflight-staging",
        `Build concluído, mas não há memória segura para o staging (${stagingWait.reason ?? "sem folga"}). ` +
          "Nenhum container de teste foi criado e a produção não foi tocada.",
        true,
      );
    }

    let stagingLog: string;
    try {
      stagingLog = await this.orchestrator.startStaging(input.config);
    } catch (error) {
      throw new SequentialDeployError(
        "staging",
        `Staging não subiu a partir da imagem construída: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }

    // Prova dupla: a referência ainda aponta para a imagem construída E o
    // container de staging está rodando exatamente essa imagem.
    const stagingImageId = await this.orchestrator.imageId(reference);
    const stagingContainerImageId = await this.orchestrator.containerImageId(
      input.config.staging.containerName,
    );
    if (
      !stagingImageId ||
      stagingImageId !== builtImageId ||
      !stagingContainerImageId ||
      stagingContainerImageId !== builtImageId
    ) {
      throw new SequentialDeployError(
        "image-changed",
        "A imagem do staging não corresponde à imagem construída; promoção bloqueada.",
        true,
        true,
      );
    }

    return {
      imageId: builtImageId,
      buildLog,
      stagingLog,
      buildDurationMs,
      stagingWaitSec: stagingWait.waitedSec,
    };
  }
}

/** Flag default OFF. Qualquer valor diferente de 1/true/yes mantém o fluxo antigo. */
export function isSequentialBuildEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.KORRELO_SEQUENTIAL_BUILD ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}
