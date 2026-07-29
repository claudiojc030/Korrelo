import { Inject, Injectable } from "@nestjs/common";
import { METRIC_SAMPLE_REPOSITORY, type MetricSampleRepository } from "../domain/metric-sample.repository";
import type { MetricSample } from "../domain/metric-sample.entity";

export type MetricHistoryRange = "1h" | "24h" | "7d";

const RANGE_MS: Record<MetricHistoryRange, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

const MAX_POINTS = 200;

export interface MetricHistoryPoint {
  capturedAt: string;
  cpuPercent: number;
  usedMemPercent: number;
  usedDiskPercent: number;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Uma amostra por minuto ao longo de 7 dias dá ~10k pontos: bom demais pro
// SQLite guardar, ruim demais pro gráfico renderizar. Agrupa em baldes de
// tamanho fixo (~MAX_POINTS no total) tirando a média de cada balde.
function downsample(samples: MetricSample[], maxPoints: number): MetricSample[] {
  if (samples.length <= maxPoints) {
    return samples;
  }

  const bucketSize = Math.ceil(samples.length / maxPoints);
  const buckets: MetricSample[] = [];
  for (let i = 0; i < samples.length; i += bucketSize) {
    const bucket = samples.slice(i, i + bucketSize);
    const mid = bucket[Math.floor(bucket.length / 2)];
    buckets.push({
      ...mid,
      cpuPercent: average(bucket.map((s) => s.cpuPercent)),
      usedMemPercent: average(bucket.map((s) => s.usedMemPercent)),
      usedDiskPercent: average(bucket.map((s) => s.usedDiskPercent)),
    } as MetricSample);
  }
  return buckets;
}

@Injectable()
export class GetMetricHistoryUseCase {
  constructor(@Inject(METRIC_SAMPLE_REPOSITORY) private readonly repository: MetricSampleRepository) {}

  async execute(range: MetricHistoryRange): Promise<MetricHistoryPoint[]> {
    const since = new Date(Date.now() - RANGE_MS[range]);
    const samples = await this.repository.findSince(since);
    const downsampled = downsample(samples, MAX_POINTS);

    return downsampled.map((sample) => ({
      capturedAt: sample.capturedAt.toISOString(),
      cpuPercent: Math.round(sample.cpuPercent * 10) / 10,
      usedMemPercent: Math.round(sample.usedMemPercent * 10) / 10,
      usedDiskPercent: Math.round(sample.usedDiskPercent * 10) / 10,
    }));
  }
}
