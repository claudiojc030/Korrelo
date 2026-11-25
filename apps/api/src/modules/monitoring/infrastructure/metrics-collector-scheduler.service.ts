import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import type { SystemMetrics } from "@korrelo/shared-types";
import { RecordMetricSampleUseCase } from "../application/record-metric-sample.use-case";
import { METRIC_SAMPLE_REPOSITORY, type MetricSampleRepository } from "../domain/metric-sample.repository";
import { ResourceHistoryService } from "../../projects/infrastructure/resource-history.service";

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

/**
 * Watchdog do CICLO INTEIRO do scheduler.
 *
 * O watchdog do GetSystemMetricsUseCase cobre só a coleta de Docker/CPU.
 * Depois do Resource Manager passou a existir um segundo await
 * (`resourceHistory.capture`) que não tinha limite: se ele não assentasse,
 * `collecting` ficava verdadeiro para sempre e o log de tick ignorado
 * aparecia a cada 10 min. Este limite fica abaixo do intervalo de 60 s para
 * o próximo tick sempre poder começar.
 */
const DEFAULT_COLLECT_TIMEOUT_MS = 50_000;

/** Token opcional: em produção nada é fornecido; testes injetam opções. */
export const METRICS_SCHEDULER_OPTIONS = Symbol("METRICS_SCHEDULER_OPTIONS");

export interface MetricsSchedulerOptions {
  collectTimeoutMs?: number;
  skipLogIntervalMs?: number;
  now?: () => number;
}

/** A coleta inteira excedeu o watchdog do scheduler. */
class MetricsCollectionTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`coleta de métricas excedeu ${timeoutMs}ms`);
    this.name = "MetricsCollectionTimeoutError";
  }
}

@Injectable()
export class MetricsCollectorSchedulerService {
  private readonly logger = new Logger(MetricsCollectorSchedulerService.name);
  /** Impede duas coletas do scheduler ao mesmo tempo (ticks sobrepostos). */
  private collecting = false;
  /** Identidade da execução atual; uma execução abandonada não altera a nova. */
  private activeRun: object | null = null;
  /** Ticks ignorados desde o último aviso (para o log resumido). */
  private skippedTicks = 0;
  private lastSkipLogAt = 0;
  private readonly collectTimeoutMs: number;
  private readonly skipLogIntervalMs: number;
  private readonly now: () => number;
  private lastSuccessAt = 0;
  private lastFailureAt = 0;
  private timeouts = 0;

  constructor(
    private readonly recordMetricSample: RecordMetricSampleUseCase,
    @Inject(METRIC_SAMPLE_REPOSITORY) private readonly repository: MetricSampleRepository,
    // Opcional para não quebrar testes/instanciações antigas: quando presente,
    // o MESMO tick alimenta o histórico de recursos (Fase A).
    @Optional() private readonly resourceHistory?: ResourceHistoryService,
    @Optional()
    @Inject(METRICS_SCHEDULER_OPTIONS)
    options: MetricsSchedulerOptions = {},
  ) {
    this.collectTimeoutMs = positiveInt(options.collectTimeoutMs, DEFAULT_COLLECT_TIMEOUT_MS);
    this.skipLogIntervalMs = positiveInt(options.skipLogIntervalMs, SKIP_LOG_INTERVAL_MS);
    this.now = options.now ?? (() => Date.now());
  }

  @Interval(COLLECT_INTERVAL_MS)
  async collect(): Promise<void> {
    if (this.collecting) {
      this.skippedTicks += 1;
      const now = this.now();
      if (now - this.lastSkipLogAt >= this.skipLogIntervalMs) {
        this.logger.warn(
          `[metrics] coleta anterior ainda em andamento - ${this.skippedTicks} tick(s) ignorado(s) desde o último aviso`,
        );
        this.lastSkipLogAt = now;
        this.skippedTicks = 0;
      }
      return;
    }

    const run = {};
    this.activeRun = run;
    this.collecting = true;
    const startedAt = this.now();
    try {
      await this.withTimeout(this.runCollection(run), this.collectTimeoutMs);
      this.lastSuccessAt = this.now();
      if (this.lastFailureAt > 0) {
        this.logger.log(
          `[metrics] coleta recuperada após falha/timeout (${Math.round(this.lastSuccessAt - this.lastFailureAt)}ms desde a última falha)`,
        );
        this.lastFailureAt = 0;
      }
      this.skippedTicks = 0;
    } catch (error) {
      this.lastFailureAt = this.now();
      if (error instanceof MetricsCollectionTimeoutError) {
        this.timeouts += 1;
        this.logger.warn(
          `[metrics] coleta excedeu ${error.timeoutMs}ms (lenta ou travada) e foi abandonada; ` +
            `o scheduler segue no próximo tick (total de timeouts=${this.timeouts})`,
        );
      } else {
        this.logger.warn(`[metrics] falha ao coletar amostra de métricas: ${error}`);
      }
    } finally {
      // Só a execução ATUAL pode liberar o lock. Uma coleta abandonada que
      // terminar depois não pode liberar (nem travar) uma execução nova.
      if (this.activeRun === run) {
        this.activeRun = null;
        this.collecting = false;
      }
      const durationMs = this.now() - startedAt;
      if (durationMs > COLLECT_INTERVAL_MS) {
        this.logger.warn(
          `[metrics] coleta levou ${durationMs}ms (acima do intervalo de ${COLLECT_INTERVAL_MS}ms); ` +
            "ticks sobrepostos foram ignorados",
        );
      }
    }
  }

  /** Estado operacional para diagnóstico/teste (sem dados sensíveis). */
  getStatus(): {
    collecting: boolean;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    timeouts: number;
    skippedTicks: number;
  } {
    return {
      collecting: this.collecting,
      lastSuccessAt: this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
      lastFailureAt: this.lastFailureAt ? new Date(this.lastFailureAt).toISOString() : null,
      timeouts: this.timeouts,
      skippedTicks: this.skippedTicks,
    };
  }

  /**
   * Pipeline real do tick: coleta de métricas + histórico de recursos.
   * Mantido separado para o watchdog poder abandoná-lo sem perder o estado
   * do scheduler. Stale/indisponível nunca vira amostra de recurso.
   */
  private async runCollection(run: object): Promise<void> {
    const metrics: SystemMetrics | null = await this.recordMetricSample.execute();
    // Execução abandonada pelo watchdog: não grava histórico com leitura
    // atrasada como se fosse do tick atual.
    if (this.activeRun !== run) return;
    if (!metrics || metrics.stale === true || metrics.available === false) return;
    if (this.resourceHistory) {
      await this.resourceHistory.capture(metrics);
    }
  }

  /** `Promise.race` com timer unref'd (não atrasa o shutdown; o servidor mantém o loop vivo). */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new MetricsCollectionTimeoutError(timeoutMs)), timeoutMs);
      timer.unref?.();
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
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

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
