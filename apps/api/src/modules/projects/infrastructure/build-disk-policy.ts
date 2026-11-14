/**
 * POLÍTICA DE ESPAÇO EM DISCO PARA BUILDS.
 *
 * O piso fixo antigo (2 GB) era menor que uma única imagem recente do Mesatta
 * (~3,7 GB totais, ~2,1 GB exclusivos). Aqui o requisito é:
 *
 *   reserva operacional (serviços/DB/logs) + estimativa do build + margem
 *
 * A estimativa usa histórico quando fornecido; caso contrário usa um valor
 * conservador documentado. `docker image size` NÃO é usado como consumo
 * adicional: camadas compartilhadas e cache do BuildKit podem mudar o total.
 */
export const DEFAULT_BUILD_DISK_RESERVE_MB = 4096;
/** Estimativa conservadora quando não há histórico confiável. */
export const DEFAULT_BUILD_DISK_ESTIMATE_MB = 4096;
export const DEFAULT_BUILD_DISK_SAFETY_MB = 1024;

export interface BuildDiskPolicy {
  reserveMb: number;
  estimateMb: number;
  safetyMb: number;
  estimateSource: "history" | "default";
}

export interface BuildDiskDecision {
  ok: boolean;
  freeMb: number | null;
  requiredMb: number;
  reserveMb: number;
  estimateMb: number;
  safetyMb: number;
  estimateSource: "history" | "default" | "override";
  reason: string | null;
  blockedBy: "disk_unknown" | "insufficient" | null;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : fallback;
}

export function readBuildDiskPolicy(env: NodeJS.ProcessEnv = process.env): BuildDiskPolicy {
  const int = (name: string, fallback: number): number => {
    const parsed = Number.parseInt(env[name] ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    reserveMb: int("KORRELO_BUILD_DISK_RESERVE_MB", DEFAULT_BUILD_DISK_RESERVE_MB),
    estimateMb: int("KORRELO_BUILD_DISK_ESTIMATE_MB", DEFAULT_BUILD_DISK_ESTIMATE_MB),
    safetyMb: int("KORRELO_BUILD_DISK_SAFETY_MB", DEFAULT_BUILD_DISK_SAFETY_MB),
    estimateSource: "default",
  };
}

export function evaluateBuildDiskPolicy(input: {
  freeMb: number | null;
  /** Histórico confiável de builds anteriores (MB), se existir. */
  historicalEstimateMb?: number | null;
  /** Override explícito do requisito TOTAL (compatibilidade/testes). */
  explicitRequiredMb?: number;
  policy?: BuildDiskPolicy;
}): BuildDiskDecision {
  const policy = input.policy ?? readBuildDiskPolicy();
  const hasHistory =
    typeof input.historicalEstimateMb === "number" &&
    Number.isFinite(input.historicalEstimateMb) &&
    input.historicalEstimateMb > 0;

  if (input.explicitRequiredMb !== undefined) {
    // Override NUNCA remove a reserva operacional/margem: ele substitui apenas
    // a ESTIMATIVA do build.
    const estimate = positiveInt(input.explicitRequiredMb, 0);
    const required = policy.reserveMb + estimate + policy.safetyMb;
    return decide(input.freeMb, required, policy, "override", estimate);
  }

  const estimate = hasHistory
    ? positiveInt(input.historicalEstimateMb ?? undefined, policy.estimateMb)
    : policy.estimateMb;
  const required = policy.reserveMb + estimate + policy.safetyMb;
  return decide(input.freeMb, required, policy, hasHistory ? "history" : "default", estimate);
}

function decide(
  freeMb: number | null,
  requiredMb: number,
  policy: BuildDiskPolicy,
  estimateSource: "history" | "default" | "override",
  estimateMb = policy.estimateMb,
): BuildDiskDecision {
  const base = {
    freeMb,
    requiredMb,
    reserveMb: policy.reserveMb,
    estimateMb,
    safetyMb: policy.safetyMb,
    estimateSource,
  };

  if (freeMb === null || !Number.isFinite(freeMb)) {
    return {
      ...base,
      ok: false,
      blockedBy: "disk_unknown",
      reason:
        "espaço em disco não pôde ser medido; build bloqueado por segurança " +
        "(reserva + estimativa não podem ser verificadas)",
    };
  }

  if (freeMb < requiredMb) {
    return {
      ...base,
      ok: false,
      blockedBy: "insufficient",
      reason:
        `disco livre insuficiente: ${Math.round(freeMb)} MB livres; ` +
        `necessário ${requiredMb} MB (reserva ${policy.reserveMb} MB + ` +
        `estimativa ${estimateMb} MB [${estimateSource}] + margem ${policy.safetyMb} MB)`,
    };
  }

  return { ...base, ok: true, blockedBy: null, reason: null };
}
