export const HEALTH_CHECKER = Symbol("HEALTH_CHECKER");

export interface HealthChecker {
  waitUntilHealthy(port: number, timeoutMs: number): Promise<boolean>;
}
