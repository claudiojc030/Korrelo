import { Inject, Injectable } from "@nestjs/common";
import type { SystemMetrics } from "@forgedesk/shared-types";
import {
  SYSTEM_METRICS_COLLECTOR,
  type SystemMetricsCollector,
} from "../domain/system-metrics-collector";

@Injectable()
export class GetSystemMetricsUseCase {
  constructor(
    @Inject(SYSTEM_METRICS_COLLECTOR) private readonly collector: SystemMetricsCollector,
  ) {}

  execute(): Promise<SystemMetrics> {
    return this.collector.collect();
  }
}
