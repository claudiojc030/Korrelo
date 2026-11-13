/**
 * Configuração de SAÚDE DO DEPLOY (diferente do healthcheck Docker do compose).
 *
 * É lida do JSON já existente `Project.healthcheckConfig` (sem migração de
 * schema) nestas chaves opcionais:
 *   - deployPath: caminho HTTP de readiness (ex.: "/health/ready"). Quando
 *     presente, SOMENTE 2xx aprova a etapa.
 *   - deployTimeoutSeconds: timeout de saúde da PRODUÇÃO e do rollback
 *     (10..300). Sem ele, mantém o default histórico de 30s.
 *
 * Projetos sem essas chaves mantêm exatamente o comportamento anterior.
 */
export const DEFAULT_DEPLOY_HEALTH_TIMEOUT_MS = 30_000;
export const MIN_DEPLOY_HEALTH_TIMEOUT_SECONDS = 10;
export const MAX_DEPLOY_HEALTH_TIMEOUT_SECONDS = 300;

export interface DeployHealthConfig {
  /** Caminho de readiness configurado; null = comportamento histórico ("/"). */
  path: string | null;
  /** Sempre true quando `path` existe; false no modo compatível. */
  require2xx: boolean;
  /** Timeout efetivo de produção/rollback. */
  timeoutMs: number;
  /** Opções prontas para o HealthChecker. */
  options: { path?: string; require2xx: boolean };
}

function clampTimeout(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_DEPLOY_HEALTH_TIMEOUT_MS / 1000;
  return Math.min(
    MAX_DEPLOY_HEALTH_TIMEOUT_SECONDS,
    Math.max(MIN_DEPLOY_HEALTH_TIMEOUT_SECONDS, Math.round(parsed)),
  );
}

export function parseDeployHealthConfig(raw: string | null): DeployHealthConfig {
  let parsed: { deployPath?: unknown; deployTimeoutSeconds?: unknown } = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      parsed = {};
    }
  }

  const rawPath = typeof parsed.deployPath === "string" ? parsed.deployPath.trim() : "";
  const path = rawPath.length > 0 ? (rawPath.startsWith("/") ? rawPath : `/${rawPath}`) : null;
  const seconds = clampTimeout(parsed.deployTimeoutSeconds);

  return {
    path,
    require2xx: path !== null,
    timeoutMs: seconds * 1000,
    options: path ? { path, require2xx: true } : { require2xx: false },
  };
}
