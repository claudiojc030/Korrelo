import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { MonitoringController } from "./presentation/monitoring.controller";
import { GetSystemMetricsUseCase } from "./application/get-system-metrics.use-case";
import { RecordMetricSampleUseCase } from "./application/record-metric-sample.use-case";
import { GetMetricHistoryUseCase } from "./application/get-metric-history.use-case";
import { GetUpdateStatusUseCase } from "./application/get-update-status.use-case";
import { StartSelfUpdateUseCase } from "./application/start-self-update.use-case";
import { GetSelfUpdateStatusUseCase } from "./application/get-self-update-status.use-case";
import { OsSystemMetricsCollector } from "./infrastructure/os-system-metrics-collector";
import { PrismaMetricSampleRepository } from "./infrastructure/prisma-metric-sample.repository";
import { MetricsCollectorSchedulerService } from "./infrastructure/metrics-collector-scheduler.service";
import { GitUpdateChecker } from "./infrastructure/git-update-checker";
import { ScriptSelfUpdater } from "./infrastructure/script-self-updater";
import { SYSTEM_METRICS_COLLECTOR } from "./domain/system-metrics-collector";
import { METRIC_SAMPLE_REPOSITORY } from "./domain/metric-sample.repository";
import { UPDATE_CHECKER } from "./domain/update-checker";
import { SELF_UPDATER } from "./domain/self-updater";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [MonitoringController],
  providers: [
    PrismaService,
    GetSystemMetricsUseCase,
    RecordMetricSampleUseCase,
    GetMetricHistoryUseCase,
    GetUpdateStatusUseCase,
    StartSelfUpdateUseCase,
    GetSelfUpdateStatusUseCase,
    MetricsCollectorSchedulerService,
    { provide: SYSTEM_METRICS_COLLECTOR, useClass: OsSystemMetricsCollector },
    { provide: METRIC_SAMPLE_REPOSITORY, useClass: PrismaMetricSampleRepository },
    { provide: UPDATE_CHECKER, useClass: GitUpdateChecker },
    { provide: SELF_UPDATER, useClass: ScriptSelfUpdater },
  ],
})
export class MonitoringModule {}
