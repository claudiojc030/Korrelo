/**
 * FIXTURE de métricas de recurso para os testes do rollout.
 *
 * Os testes do rollout NUNCA podem depender das métricas reais da máquina
 * que roda o Jest. Já aconteceu: no GitHub Actions o load average real do
 * runner (1.52) passou do limite configurado (1.5) e o resource-preflight
 * abortou o rollout no meio de vários testes, derrubando em cascata suites
 * inteiras (backup, migration, PM2, snapshot, rollback).
 *
 * Por isso a medição é INJETÁVEL: `executeRollout` recebe um
 * `resourceProvider` fake nos testes e o provider real em produção.
 *
 * Uso:
 *   await executeRollout({ config, run, resourceProvider: safeResourceProvider() });
 *
 * Só as suítes que testam PRESSÃO DE RECURSO variam os valores
 * (rollout-resource-guard.spec.ts e rollout-rollback-safe.spec.ts).
 */

/** Métricas seguras: nunca barram o resource guard. */
export const SAFE_RESOURCES = {
  memAvailableMb: 4096,
  memTotalMb: 8192,
  swapUsedMb: 0,
  swapTotalMb: 2048,
  load1: 0.1,
  load5: 0.1,
  load15: 0.1,
  diskAvailableGb: 20,
  diskTotalGb: 40,
  measurable: true,
};

export type ResourceMetrics = typeof SAFE_RESOURCES;

/**
 * Provider fake com métricas fixas.
 *
 * @param overrides substitui campos pontuais (ex.: `{ load1: 2.0 }`).
 */
export function safeResourceProvider(overrides: Partial<ResourceMetrics> = {}) {
  const metrics = { ...SAFE_RESOURCES, ...overrides };
  return {
    async getMemInfo() {
      return {
        memTotalMb: metrics.memTotalMb,
        memAvailableMb: metrics.memAvailableMb,
        swapTotalMb: metrics.swapTotalMb,
        swapUsedMb: metrics.swapUsedMb,
      };
    },
    async getLoadAverage() {
      return [metrics.load1, metrics.load5, metrics.load15];
    },
    async getDiskFree() {
      return { diskAvailableGb: metrics.diskAvailableGb, diskTotalGb: metrics.diskTotalGb };
    },
  };
}

/**
 * Provider que simula um host REAL sob pressão (load 10) - usado para
 * provar que o rollout usa o provider INJETADO e não o host real.
 */
export function overloadedHostProvider() {
  return safeResourceProvider({ load1: 10, load5: 9, load15: 8 });
}
