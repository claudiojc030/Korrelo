import { Inject, Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { RecordMetricSampleUseCase } from "../application/record-metric-sample.use-case";
import { METRIC_SAMPLE_REPOSITORY, type MetricSampleRepository } from "../domain/metric-sample.repository";

const COLLECT_INTERVAL_MS = 60_000;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
const RETENTION_DAYS = 7;
/**
 * Intervalo mínimo entre avisos de "coleta anterior ainda em andamento".
 *
 * O watchdog do GetSystemMetricsUseCase (20s) garante que `collecting` é
 * liberado; este limite existe para que, se algo travar de novo, o log não
 * vire uma linha por minuto para sempre.
 */
const SKIP_LOG_INTERVAL_MS = 10 * 60 * 1000;

@Injectable()
export class MetricsCollectorSchedulerService {
  private readonly logger = new Logger(MetricsCollectorSchedulerService.name);
  /** Impede duas coletas do scheduler ao mesmo tempo (ticks sobrepostos). */
  private collecting = false;
  /** Ticks ignorados desde o último aviso (para o log resumido). */
  private skippedTicks = 0;
  private lastSkipLogAt = 0;

  constructor(
    private readonly recordMetricSample: RecordMetricSampleUseCase,
    @Inject(METRIC_SAMPLE_REPOSITORY) private readonly repository: MetricSampleRepository,
  ) {}

  @Interval(COLLECT_INTERVAL_MS)
  async collect(): Promise<void> {
    if (this.collecting) {
      this.skippedTicks += 1;
      const now = Date.now();
      if (now - this.lastSkipLogAt >= SKIP_LOG_INTERVAL_MS) {
        this.logger.warn(
          `[metrics] coleta anterior ainda em andamento - ${this.skippedTicks} tick(s) ignorado(s) desde o último aviso`,
        );
        this.lastSkipLogAt = now;
        this.skippedTicks = 0;
      }
      return;
    }
    this.collecting = true;
    try {
      await this.recordMetricSample.execute();
      this.skippedTicks = 0;
    } catch (error) {
      this.logger.warn(`[metrics] falha ao coletar amostra de métricas: ${error}`);
    } finally {
      // Sempre liberado: exceção, timeout do watchdog ou sucesso.
      this.collecting = false;
    }
  }

  @Interval(PURGE_INTERVAL_MS)
  async purgeOldSamples(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const deleted = await this.repository.deleteOlderThan(cutoff);
    if (deleted > 0) {
      this.logger.log(`${deleted} amostra(s) de métrica com mais de ${RETENTION_DAYS} dias removida(s).`);
    }
  }
}
