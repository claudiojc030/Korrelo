/**
 * HISTÓRICO DE MÉTRICAS (a amostra não pode entrar com CPU inválida).
 *
 * Com a CPU agora podendo ser null (primeira amostra sem delta), gravar
 * isso no histórico criaria um pico artificial no gráfico: null viraria
 * 0% (ou 100%) e a linha do gráfico mentiria.
 *
 * Aqui provamos que a amostra com CPU inválida NÃO é persistida, e que
 * uma amostra válida continua sendo gravada normalmente.
 */

import { RecordMetricSampleUseCase } from "./record-metric-sample.use-case";
import type { MetricSampleRepository } from "../domain/metric-sample.repository";
import type { SystemMetrics } from "@korrelo/shared-types";

class FakeSampleRepository {
  saved: any[] = [];
  async save(sample: any): Promise<any> {
    this.saved.push(sample);
    return sample;
  }
  async deleteOlderThan(): Promise<number> {
    return 0;
  }
}

function metrics(overrides: Partial<SystemMetrics> = {}): SystemMetrics {
  return {
    cpuPercent: 7,
    totalMemMb: 3915,
    freeMemMb: 2648,
    usedMemPercent: 32,
    diskTotalGb: 48,
    diskFreeGb: 26.9,
    usedDiskPercent: 44,
    uptimeSeconds: 3600,
    tier: "small",
    containers: [],
    ...overrides,
  };
}

describe("RecordMetricSampleUseCase - CPU inválida não entra no histórico", () => {
  it("1) cpuPercent null NÃO é persistido (nada de 0% ou 100% falsos)", async () => {
    const repository = new FakeSampleRepository();
    const useCase = new RecordMetricSampleUseCase(
      { execute: async () => metrics({ cpuPercent: null }) } as never,
      repository as unknown as MetricSampleRepository,
    );

    await useCase.execute();

    expect(repository.saved).toHaveLength(0);
  });

  it("2) cpuPercent válido É persistido", async () => {
    const repository = new FakeSampleRepository();
    const useCase = new RecordMetricSampleUseCase(
      { execute: async () => metrics({ cpuPercent: 7 }) } as never,
      repository as unknown as MetricSampleRepository,
    );

    await useCase.execute();

    expect(repository.saved).toHaveLength(1);
    expect(repository.saved[0].cpuPercent).toBe(7);
  });

  it("3) leitura stale também não entra (comportamento já existente)", async () => {
    const repository = new FakeSampleRepository();
    const useCase = new RecordMetricSampleUseCase(
      { execute: async () => metrics({ cpuPercent: 7, stale: true }) } as never,
      repository as unknown as MetricSampleRepository,
    );

    await useCase.execute();

    expect(repository.saved).toHaveLength(0);
  });

  it("4) cpuPercent 0 (medição real de host ocioso) É persistido", async () => {
    const repository = new FakeSampleRepository();
    const useCase = new RecordMetricSampleUseCase(
      { execute: async () => metrics({ cpuPercent: 0 }) } as never,
      repository as unknown as MetricSampleRepository,
    );

    await useCase.execute();

    expect(repository.saved).toHaveLength(1);
    expect(repository.saved[0].cpuPercent).toBe(0);
  });
});
