export const HEALTH_CHECKER = Symbol("HEALTH_CHECKER");

/**
 * Contrato OPCIONAL de saúde para o deploy.
 *
 * Sem opções (ou sem `path`), mantém o comportamento histórico: qualquer
 * resposta HTTP em "/" é considerada viva. Quando o projeto configura um
 * readiness (ex.: "/health/ready"), SOMENTE status 2xx aprova a etapa.
 */
export interface HealthCheckOptions {
  path?: string | null;
  require2xx?: boolean;
}

export interface HealthChecker {
  waitUntilHealthy(port: number, timeoutMs: number, options?: HealthCheckOptions): Promise<boolean>;
}
