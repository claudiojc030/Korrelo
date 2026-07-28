import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { MonitoringController } from "./presentation/monitoring.controller";
import { GetSystemMetricsUseCase } from "./application/get-system-metrics.use-case";
import { RecordMetricSampleUseCase } from "./application/record-metric-sample.use-case";
import { GetMetricHistoryUseCase } from "./application/get-metric-history.use-case";
import { OsSystemMetricsCollector } from "./infrastructure/os-system-metrics-collector";
import { PrismaMetricSampleRepository } from "./infrastructure/prisma-metric-sample.repository";
import { MetricsCollectorSchedulerService } from "./infrastructure/metrics-collector-scheduler.service";
import { SYSTEM_METRICS_COLLECTOR } from "./domain/system-metrics-collector";
import { METRIC_SAMPLE_REPOSITORY } from "./domain/metric-sample.repository";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [MonitoringController],
  providers: [
    PrismaService,
    GetSystemMetricsUseCase,
    RecordMetricSampleUseCase,
    GetMetricHistoryUseCase,
    MetricsCollectorSchedulerService,
    { provide: SYSTEM_METRICS_COLLECTOR, useClass: OsSystemMetricsCollector },
    { provide: METRIC_SAMPLE_REPOSITORY, useClass: PrismaMetricSampleRepository },
  ],
})
export class MonitoringModule {}
