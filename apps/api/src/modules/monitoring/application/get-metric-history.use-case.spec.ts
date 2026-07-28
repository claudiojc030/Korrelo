import { GetMetricHistoryUseCase } from "./get-metric-history.use-case";
import { MetricSample } from "../domain/metric-sample.entity";
import type { MetricSampleRepository } from "../domain/metric-sample.repository";

function buildSamples(count: number): MetricSample[] {
  const base = new Date("2026-01-01T00:00:00.000Z").getTime();
  return Array.from({ length: count }, (_, i) => new MetricSample(`id-${i}`, i % 100, (i * 2) % 100, 50, new Date(base + i * 60_000)));
}

describe("GetMetricHistoryUseCase", () => {
  it("retorna as amostras sem downsample quando estao dentro do limite", async () => {
    const samples = buildSamples(10);
    const repository: MetricSampleRepository = {
      save: jest.fn(),
      findSince: jest.fn().mockResolvedValue(samples),
      deleteOlderThan: jest.fn(),
    };
    const useCase = new GetMetricHistoryUseCase(repository);

    const result = await useCase.execute("1h");

    expect(result).toHaveLength(10);
    expect(result[0].cpuPercent).toBe(0);
  });

  it("agrupa em baldes quando ha mais amostras que o limite de pontos", async () => {
    const samples = buildSamples(1000);
    const repository: MetricSampleRepository = {
      save: jest.fn(),
      findSince: jest.fn().mockResolvedValue(samples),
      deleteOlderThan: jest.fn(),
    };
    const useCase = new GetMetricHistoryUseCase(repository);

    const result = await useCase.execute("7d");

    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.length).toBeGreaterThan(0);
    // ordem cronológica preservada
    const timestamps = result.map((p) => new Date(p.capturedAt).getTime());
    expect([...timestamps].sort((a, b) => a - b)).toEqual(timestamps);
  });

  it("retorna lista vazia quando nao ha amostras no periodo", async () => {
    const repository: MetricSampleRepository = {
      save: jest.fn(),
      findSince: jest.fn().mockResolvedValue([]),
      deleteOlderThan: jest.fn(),
    };
    const useCase = new GetMetricHistoryUseCase(repository);

    const result = await useCase.execute("24h");

    expect(result).toEqual([]);
  });
});
