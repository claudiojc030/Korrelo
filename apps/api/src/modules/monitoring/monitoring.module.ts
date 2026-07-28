import { Module } from "@nestjs/common";
import { MonitoringController } from "./presentation/monitoring.controller";
import { GetSystemMetricsUseCase } from "./application/get-system-metrics.use-case";
import { OsSystemMetricsCollector } from "./infrastructure/os-system-metrics-collector";
import { SYSTEM_METRICS_COLLECTOR } from "./domain/system-metrics-collector";

@Module({
  controllers: [MonitoringController],
  providers: [
    GetSystemMetricsUseCase,
    { provide: SYSTEM_METRICS_COLLECTOR, useClass: OsSystemMetricsCollector },
  ],
})
export class MonitoringModule {}
