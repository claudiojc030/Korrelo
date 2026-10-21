import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { ProjectsModule } from "../projects/projects.module";
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
import { FileSelfUpdateJobRepository } from "./infrastructure/file-self-update-job.repository";
import { SelfUpdateRecoveryService } from "./infrastructure/self-update-recovery.service";
import { StorageAuditService } from "./infrastructure/storage-audit.service";
import { CleanupStorageUseCase } from "./application/cleanup-storage.use-case";
import { DeployQueueService } from "../projects/infrastructure/deploy-queue.service";
import { SYSTEM_METRICS_COLLECTOR } from "./domain/system-metrics-collector";
import { METRIC_SAMPLE_REPOSITORY } from "./domain/metric-sample.repository";
import { UPDATE_CHECKER } from "./domain/update-checker";
import { SELF_UPDATER, type SelfUpdater } from "./domain/self-updater";
import { SELF_UPDATE_JOB_REPOSITORY } from "./domain/self-update-job.entity";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";

@Module({
  // ProjectsModule entra aqui porque o self-update precisa do worker de
  // deploy: para ele (drain) e recusa a atualização se houver deploy em
  // andamento.
  imports: [ScheduleModule.forRoot(), ProjectsModule],
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
    SelfUpdateRecoveryService,
    StorageAuditService,
    CleanupStorageUseCase,
    {
      // A limpeza de armazenamento é RECUSADA enquanto houver self-update
      // ou deploy em andamento (mexer no disco no meio de um build/update
      // é risco).
      provide: CleanupStorageUseCase,
      useFactory: (
        audit: StorageAuditService,
        updater: SelfUpdater,
        deployQueue: DeployQueueService,
      ) => new CleanupStorageUseCase(audit, undefined, updater, deployQueue),
      inject: [StorageAuditService, SELF_UPDATER, DeployQueueService],
    },
    { provide: SYSTEM_METRICS_COLLECTOR, useClass: OsSystemMetricsCollector },
    { provide: METRIC_SAMPLE_REPOSITORY, useClass: PrismaMetricSampleRepository },
    { provide: UPDATE_CHECKER, useClass: GitUpdateChecker },
    { provide: SELF_UPDATER, useClass: ScriptSelfUpdater },
    { provide: SELF_UPDATE_JOB_REPOSITORY, useClass: FileSelfUpdateJobRepository },
  ],
})
export class MonitoringModule {}
