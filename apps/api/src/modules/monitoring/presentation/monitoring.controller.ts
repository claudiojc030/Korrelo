import { Controller, Get, Query } from "@nestjs/common";
import { GetSystemMetricsUseCase } from "../application/get-system-metrics.use-case";
import { GetMetricHistoryUseCase, type MetricHistoryRange } from "../application/get-metric-history.use-case";

const VALID_RANGES: MetricHistoryRange[] = ["1h", "24h", "7d"];

@Controller("monitoring")
export class MonitoringController {
  constructor(
    private readonly getSystemMetrics: GetSystemMetricsUseCase,
    private readonly getMetricHistory: GetMetricHistoryUseCase,
  ) {}

  @Get("system")
  system() {
    return this.getSystemMetrics.execute();
  }

  @Get("history")
  history(@Query("range") range?: string) {
    const parsedRange = VALID_RANGES.includes(range as MetricHistoryRange) ? (range as MetricHistoryRange) : "1h";
    return this.getMetricHistory.execute(parsedRange);
  }
}
