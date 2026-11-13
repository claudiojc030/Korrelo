/**
 * Configuração de healthcheck do projeto (Docker + saúde do DEPLOY).
 *
 * O backend guarda tudo no MESMO JSON `healthcheckConfig`. Estes helpers
 * preservam os campos que a tela não está editando — inclusive
 * `deployPath`/`deployTimeoutSeconds` quando o usuário salva somente o
 * healthcheck Docker (e vice-versa).
 */
export interface HealthcheckConfig {
  enabled: boolean;
  path: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  retries: number;
  startPeriodSeconds: number;
  /** Readiness do deploy; ausente = comportamento histórico. */
  deployPath?: string;
  /** Timeout de produção/rollback em segundos. */
  deployTimeoutSeconds?: number;
}

export const DEFAULT_HEALTHCHECK: Omit<HealthcheckConfig, "deployPath" | "deployTimeoutSeconds"> = {
  enabled: false,
  path: "/",
  intervalSeconds: 30,
  timeoutSeconds: 5,
  retries: 3,
  startPeriodSeconds: 120,
};

/** Lê o JSON persistido; null/ inválido vira null (sem inventar config). */
export function readHealthcheckConfig(raw: string | null | undefined): HealthcheckConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<HealthcheckConfig>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      enabled: parsed.enabled === true,
      path: typeof parsed.path === "string" && parsed.path ? parsed.path : "/",
      intervalSeconds: numberOr(parsed.intervalSeconds, 30),
      timeoutSeconds: numberOr(parsed.timeoutSeconds, 5),
      retries: numberOr(parsed.retries, 3),
      startPeriodSeconds: numberOr(parsed.startPeriodSeconds, 120),
      ...(typeof parsed.deployPath === "string" && parsed.deployPath.length > 0
        ? { deployPath: parsed.deployPath }
        : {}),
      ...(typeof parsed.deployTimeoutSeconds === "number" &&
      Number.isFinite(parsed.deployTimeoutSeconds)
        ? { deployTimeoutSeconds: parsed.deployTimeoutSeconds }
        : {}),
    };
  } catch {
    return null;
  }
}

export interface HealthcheckChanges {
  enabled?: boolean;
  path?: string;
  intervalSeconds?: number;
  timeoutSeconds?: number;
  retries?: number;
  startPeriodSeconds?: number;
  /** string vazia remove o readiness (volta ao comportamento histórico). */
  deployPath?: string;
  /** string vazia/ inválida remove o timeout de deploy. */
  deployTimeoutSeconds?: string;
}

/** Monta o objeto enviado ao PATCH preservando o que não foi alterado. */
export function buildHealthcheckPayload(
  base: HealthcheckConfig | null,
  changes: HealthcheckChanges,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...DEFAULT_HEALTHCHECK,
    ...(base
      ? {
          enabled: base.enabled,
          path: base.path,
          intervalSeconds: base.intervalSeconds,
          timeoutSeconds: base.timeoutSeconds,
          retries: base.retries,
          startPeriodSeconds: base.startPeriodSeconds,
        }
      : {}),
    ...(base?.deployPath ? { deployPath: base.deployPath } : {}),
    ...(base?.deployTimeoutSeconds ? { deployTimeoutSeconds: base.deployTimeoutSeconds } : {}),
    ...(changes.enabled !== undefined ? { enabled: changes.enabled } : {}),
    ...(changes.path !== undefined ? { path: normalizePath(changes.path) } : {}),
    ...(changes.intervalSeconds !== undefined ? { intervalSeconds: changes.intervalSeconds } : {}),
    ...(changes.timeoutSeconds !== undefined ? { timeoutSeconds: changes.timeoutSeconds } : {}),
    ...(changes.retries !== undefined ? { retries: changes.retries } : {}),
    ...(changes.startPeriodSeconds !== undefined
      ? { startPeriodSeconds: changes.startPeriodSeconds }
      : {}),
  };

  if (changes.deployPath !== undefined) {
    const path = changes.deployPath.trim();
    if (path.length > 0) merged.deployPath = normalizePath(path);
    else delete merged.deployPath;
  }
  if (changes.deployTimeoutSeconds !== undefined) {
    const seconds = Number(changes.deployTimeoutSeconds);
    if (changes.deployTimeoutSeconds.trim().length > 0 && Number.isFinite(seconds) && seconds > 0) {
      merged.deployTimeoutSeconds = Math.round(seconds);
    } else {
      delete merged.deployTimeoutSeconds;
    }
  }

  return merged;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}
