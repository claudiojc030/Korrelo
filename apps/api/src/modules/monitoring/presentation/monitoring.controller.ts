import { Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { GetSystemMetricsUseCase } from "../application/get-system-metrics.use-case";
import { GetMetricHistoryUseCase, type MetricHistoryRange } from "../application/get-metric-history.use-case";
import { GetUpdateStatusUseCase } from "../application/get-update-status.use-case";
import { StartSelfUpdateUseCase } from "../application/start-self-update.use-case";
import { GetSelfUpdateStatusUseCase } from "../application/get-self-update-status.use-case";
import { SELF_UPDATER, type SelfUpdater } from "../domain/self-updater";
import { SELF_UPDATE_JOB_REPOSITORY, type SelfUpdateJobRepository } from "../domain/self-update-job.entity";

const VALID_RANGES: MetricHistoryRange[] = ["1h", "24h", "7d"];

@Controller("monitoring")
export class MonitoringController {
  constructor(
    private readonly getSystemMetrics: GetSystemMetricsUseCase,
    private readonly getMetricHistory: GetMetricHistoryUseCase,
    private readonly getUpdateStatus: GetUpdateStatusUseCase,
    private readonly startSelfUpdate: StartSelfUpdateUseCase,
    private readonly getSelfUpdateStatus: GetSelfUpdateStatusUseCase,
    @Inject(SELF_UPDATER) private readonly updater: SelfUpdater,
    @Inject(SELF_UPDATE_JOB_REPOSITORY) private readonly jobs: SelfUpdateJobRepository,
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

  @Get("update-status")
  updateStatus() {
    return this.getUpdateStatus.execute();
  }

  @Post("update/start")
  startUpdate() {
    return this.startSelfUpdate.execute();
  }

  @Get("update/status")
  selfUpdateStatus() {
    return this.getSelfUpdateStatus.execute();
  }

  /**
   * Self-update DESACOPLADO (Wave 3).
   *
   * O POST responde na hora (com o id do job) e o update continua num
   * processo detached: sobrevive ao restart da API/Web, ao fechamento do
   * navegador e à queda do WebSocket.
   */
  @Post("self-update")
  async startSelfUpdateDetached() {
    const result = await this.startSelfUpdate.execute();
    return { jobId: result.jobId, status: result.status, alreadyRunning: result.alreadyRunning };
  }

  /** Estado do update em andamento (ou do último) - a UI usa para retomar. */
  @Get("self-update/current")
  async currentSelfUpdate() {
    const status = await this.updater.getStatus();
    const job = status.jobId ? await this.jobs.findById(status.jobId) : await this.jobs.findLatest();
    return { ...status, job };
  }

  @Get("self-update/:id")
  async selfUpdateById(@Param("id") id: string) {
    const job = await this.jobs.findById(id);
    if (!job) return { found: false, job: null };
    return { found: true, job };
  }

  @Get("self-update/:id/log")
  async selfUpdateLog(@Param("id") id: string) {
    const log = await this.updater.getJobLog(id);
    return { id, log };
  }
}
