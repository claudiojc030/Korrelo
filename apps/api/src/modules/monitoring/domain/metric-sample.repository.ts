import type { MetricSample } from "./metric-sample.entity";

export const METRIC_SAMPLE_REPOSITORY = Symbol("METRIC_SAMPLE_REPOSITORY");

export interface MetricSampleRepository {
  save(sample: MetricSample): Promise<MetricSample>;
  findSince(since: Date): Promise<MetricSample[]>;
  deleteOlderThan(cutoff: Date): Promise<number>;
}
