import { Inject, Injectable, Logger } from "@nestjs/common";
import type { SystemMetrics } from "@korrelo/shared-types";
import { METRIC_SAMPLE_REPOSITORY, type MetricSampleRepository } from "../domain/metric-sample.repository";
import { MetricSample } from "../domain/metric-sample.entity";
import { GetSystemMetricsUseCase } from "./get-system-metrics.use-case";

/**
 * Grava uma amostra do gráfico de histórico.
 *
 * Usa o MESMO caso de uso do endpoint HTTP (GetSystemMetricsUseCase) de
 * propósito: assim o coletor de background e o dashboard compartilham o
 * cache, o backoff e o circuito. Antes, cada um chamava o Docker por conta
 * própria - o scheduler disparava um `docker stats` a cada minuto mesmo
 * quando o dashboard já estava com uma coleta em andamento (ou travada).
 */
@Injectable()
export class RecordMetricSampleUseCase {
  private readonly logger = new Logger(RecordMetricSampleUseCase.name);

  constructor(
    private readonly getSystemMetrics: GetSystemMetricsUseCase,
    @Inject(METRIC_SAMPLE_REPOSITORY) private readonly repository: MetricSampleRepository,
  ) {}

  /**
   * Devolve a leitura usada na amostra para que o MESMO tick alimente o
   * histórico de recursos (Resource Manager). `null` = nada foi gravado
   * (leitura stale/indisponível/CPU inválida), e o histórico também não deve
   * receber uma amostra.
   */
  async execute(): Promise<SystemMetrics | null> {
    const metrics = await this.getSystemMetrics.execute();

    // Amostra de cache (stale) ou coleta indisponível não entram no
    // histórico: o gráfico precisa mostrar a leitura real, senão uma falha
    // do Docker viraria uma linha reta "falsa" de CPU/memória.
    if (metrics.stale === true || metrics.available === false) {
      this.logger.warn("[metrics] amostra ignorada: última leitura é desatualizada ou indisponível");
      return null;
    }

    // Sem medição de CPU válida (primeira amostra / leitura inválida) a
    // amostra NÃO entra no histórico: gravar null como 0% ou 100% cria um
    // pico artificial no gráfico.
    if (metrics.cpuPercent === null || metrics.cpuPercent === undefined) {
      this.logger.warn("[metrics] amostra ignorada: ainda sem medição válida de CPU");
      return null;
    }

    const sample = MetricSample.create(metrics.cpuPercent, metrics.usedMemPercent, metrics.usedDiskPercent ?? 0);
    await this.repository.save(sample);
    return metrics;
  }
}
