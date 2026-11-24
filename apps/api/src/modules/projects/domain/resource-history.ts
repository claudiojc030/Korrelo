/**
 * HISTÓRICO LEVE DE RECURSOS (Resource Manager V1 — Fase A).
 *
 * Memória de processo com anel limitado + persistência opcional em JSON. Nada
 * de agente, banco novo ou dependência externa: uma amostra por minuto, no
 * máximo 24 h, custa poucos KB por hora.
 *
 * A amostra guarda o que o planejador precisa para substituir "limite
 * histórico" por "pico observado": MemAvailable, swap usada/atividade, PSI,
 * load, CPU do host e uso/limite de cada container.
 */

export interface ContainerResourceSample {
  name: string;
  usageMb: number | null;
  limitMb: number | null;
  cpuPercent: number | null;
}

export interface ResourceSample {
  /** epoch ms */
  at: number;
  memAvailableMb: number | null;
  memTotalMb: number | null;
  swapUsedMb: number | null;
  /** páginas trocadas na janela de amostragem (0 = sem pressão ativa) */
  swapInDelta: number | null;
  swapOutDelta: number | null;
  psiSome10: number | null;
  psiFull10: number | null;
  load1: number | null;
  hostCpuPercent: number | null;
  containers: ContainerResourceSample[];
}

export interface ContainerResourceSummary {
  name: string;
  samples: number;
  currentMb: number | null;
  peakMb: number | null;
  averageMb: number | null;
  limitMb: number | null;
}

export interface ResourceHistorySummary {
  samples: number;
  /** janela coberta pelas amostras (ms) */
  windowMs: number;
  /** idade da amostra mais recente (ms) */
  lastSampleAgeMs: number | null;
  container: ContainerResourceSummary | null;
  host: {
    minMemAvailableMb: number | null;
    maxSwapActivityPages: number | null;
    maxPsiFull10: number | null;
  };
}

export type HistoryConfidence = "none" | "low" | "medium" | "high";

const DAY_MS = 24 * 60 * 60 * 1000;

export class ResourceHistory {
  private samples: ResourceSample[] = [];

  constructor(
    private readonly options: { maxSamples?: number; maxAgeMs?: number } = {},
  ) {}

  private get maxSamples(): number {
    return this.options.maxSamples ?? 1500;
  }

  private get maxAgeMs(): number {
    return this.options.maxAgeMs ?? DAY_MS;
  }

  add(sample: ResourceSample): void {
    this.samples.push(sample);
    this.prune();
  }

  /** Remove por idade e por quantidade; mantém ordem cronológica. */
  prune(now = Date.now()): void {
    const cutoff = now - this.maxAgeMs;
    this.samples = this.samples
      .filter((sample) => sample.at >= cutoff && sample.at <= now + 60_000)
      .sort((a, b) => a.at - b.at)
      .slice(-this.maxSamples);
  }

  size(): number {
    return this.samples.length;
  }

  all(): ResourceSample[] {
    return [...this.samples];
  }

  clear(): void {
    this.samples = [];
  }

  /**
   * Resumo para um container (nome exato do `docker stats`, sem "/").
   * Considera apenas amostras em que o container apareceu.
   */
  summary(containerName: string, now = Date.now()): ResourceHistorySummary {
    this.prune(now);
    const relevant = this.samples.filter((sample) =>
      sample.containers.some((container) => container.name === containerName),
    );
    const values = relevant
      .map((sample) => sample.containers.find((container) => container.name === containerName))
      .filter((container): container is ContainerResourceSample => Boolean(container));
    const usages = values
      .map((container) => container.usageMb)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const limits = values
      .map((container) => container.limitMb)
      .filter((value): value is number => typeof value === "number" && value > 0);

    const newest = this.samples.at(-1) ?? null;
    const oldest = this.samples[0] ?? null;
    const swapActivity = this.samples
      .map((sample) =>
        sample.swapInDelta !== null && sample.swapOutDelta !== null
          ? sample.swapInDelta + sample.swapOutDelta
          : null,
      )
      .filter((value): value is number => value !== null);
    const memAvailable = this.samples
      .map((sample) => sample.memAvailableMb)
      .filter((value): value is number => value !== null);
    const psiFull = this.samples
      .map((sample) => sample.psiFull10)
      .filter((value): value is number => value !== null);

    return {
      samples: relevant.length,
      windowMs: oldest && newest ? newest.at - oldest.at : 0,
      lastSampleAgeMs: newest ? now - newest.at : null,
      container:
        values.length === 0
          ? null
          : {
              name: containerName,
              samples: values.length,
              currentMb: usages.length > 0 ? usages[usages.length - 1] : null,
              peakMb: usages.length > 0 ? Math.max(...usages) : null,
              averageMb:
                usages.length > 0
                  ? Math.round(usages.reduce((sum, value) => sum + value, 0) / usages.length)
                  : null,
              limitMb: limits.length > 0 ? Math.max(...limits) : null,
            },
      host: {
        minMemAvailableMb: memAvailable.length > 0 ? Math.min(...memAvailable) : null,
        maxSwapActivityPages: swapActivity.length > 0 ? Math.max(...swapActivity) : null,
        maxPsiFull10: psiFull.length > 0 ? Math.max(...psiFull) : null,
      },
    };
  }

  /** Serialização compacta (persistência em arquivo). */
  toJSON(): { version: 1; samples: ResourceSample[] } {
    return { version: 1, samples: this.samples };
  }

  static fromJSON(raw: unknown, options: { maxSamples?: number; maxAgeMs?: number } = {}): ResourceHistory {
    const history = new ResourceHistory(options);
    if (!raw || typeof raw !== "object") return history;
    const samples = (raw as { samples?: unknown }).samples;
    if (!Array.isArray(samples)) return history;
    for (const entry of samples) {
      if (!entry || typeof entry !== "object") continue;
      const sample = entry as Partial<ResourceSample>;
      if (typeof sample.at !== "number" || !Number.isFinite(sample.at)) continue;
      history.add({
        at: sample.at,
        memAvailableMb: numberOrNull(sample.memAvailableMb),
        memTotalMb: numberOrNull(sample.memTotalMb),
        swapUsedMb: numberOrNull(sample.swapUsedMb),
        swapInDelta: numberOrNull(sample.swapInDelta),
        swapOutDelta: numberOrNull(sample.swapOutDelta),
        psiSome10: numberOrNull(sample.psiSome10),
        psiFull10: numberOrNull(sample.psiFull10),
        load1: numberOrNull(sample.load1),
        hostCpuPercent: numberOrNull(sample.hostCpuPercent),
        containers: Array.isArray(sample.containers)
          ? sample.containers
              .filter((container): container is ContainerResourceSample => Boolean(container))
              .map((container) => ({
                name: String(container.name ?? ""),
                usageMb: numberOrNull(container.usageMb),
                limitMb: numberOrNull(container.limitMb),
                cpuPercent: numberOrNull(container.cpuPercent),
              }))
              .filter((container) => container.name.length > 0)
          : [],
      });
    }
    return history;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Qualidade do histórico. Sem dados recentes/suficientes, a política
 * adaptativa NÃO deve ser usada (cai na conservadora).
 */
export function classifyHistoryConfidence(
  summary: ResourceHistorySummary | null,
  params: { now?: number; maxAgeMs?: number; minSamples?: number; minWindowMs?: number } = {},
): HistoryConfidence {
  if (!summary || summary.container === null || summary.container.samples === 0) return "none";
  const maxAgeMs = params.maxAgeMs ?? 10 * 60 * 1000;
  const minSamples = params.minSamples ?? 10;
  const minWindowMs = params.minWindowMs ?? 10 * 60 * 1000;
  if (summary.lastSampleAgeMs !== null && summary.lastSampleAgeMs > maxAgeMs) return "low";
  if (summary.samples >= minSamples * 3 && summary.windowMs >= minWindowMs * 3) return "high";
  if (summary.samples >= minSamples && summary.windowMs >= minWindowMs) return "medium";
  return "low";
}
