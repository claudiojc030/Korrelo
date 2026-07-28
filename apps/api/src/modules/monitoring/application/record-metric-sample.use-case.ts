import { Inject, Injectable } from "@nestjs/common";
import { SYSTEM_METRICS_COLLECTOR, type SystemMetricsCollector } from "../domain/system-metrics-collector";
import { METRIC_SAMPLE_REPOSITORY, type MetricSampleRepository } from "../domain/metric-sample.repository";
import { MetricSample } from "../domain/metric-sample.entity";

@Injectable()
export class RecordMetricSampleUseCase {
  constructor(
    @Inject(SYSTEM_METRICS_COLLECTOR) private readonly collector: SystemMetricsCollector,
    @Inject(METRIC_SAMPLE_REPOSITORY) private readonly repository: MetricSampleRepository,
  ) {}

  async execute(): Promise<void> {
    const metrics = await this.collector.collect();
    const sample = MetricSample.create(metrics.cpuPercent, metrics.usedMemPercent, metrics.usedDiskPercent ?? 0);
    await this.repository.save(sample);
  }
}
