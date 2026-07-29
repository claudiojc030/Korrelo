import { Inject, Injectable } from "@nestjs/common";
import type { SystemMetrics } from "@korrelo/shared-types";
import {
  SYSTEM_METRICS_COLLECTOR,
  type SystemMetricsCollector,
} from "../domain/system-metrics-collector";

// collect() roda docker ps/stats + leitura de disco, e isso é caro o bastante (chega
// a ~2s neste ambiente) pra valer a pena não repetir se duas chamadas caírem
// quase juntas (o poll do dashboard e o coletor em background de métricas,
// por exemplo). Cache curtíssimo com dedupe do in-flight: uma chamada em
// andamento é reaproveitada por qualquer outra que chegar antes dela
// terminar, e o resultado fica bom por mais alguns segundos depois.
const CACHE_TTL_MS = 3_000;

@Injectable()
export class GetSystemMetricsUseCase {
  private cached: { value: SystemMetrics; expiresAt: number } | null = null;
  private inFlight: Promise<SystemMetrics> | null = null;

  constructor(
    @Inject(SYSTEM_METRICS_COLLECTOR) private readonly collector: SystemMetricsCollector,
  ) {}

  async execute(): Promise<SystemMetrics> {
    if (this.cached && this.cached.expiresAt > Date.now()) {
      return this.cached.value;
    }
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.collector.collect();
    try {
      const value = await this.inFlight;
      this.cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
      return value;
    } finally {
      this.inFlight = null;
    }
  }
}
