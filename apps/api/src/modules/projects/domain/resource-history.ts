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
  /**
   * ID efetivo do container Docker (quando disponível). Um ID novo com o
   * mesmo nome indica recriação; históricos de IDs diferentes NÃO são
   * equivalentes para decisões automáticas.
   */
  containerId?: string | null;
  /**
   * Pico real do cgroup, quando o coletor conseguir ler `memory.peak`.
   * null/ausente = indisponível; nunca é inventado a partir do amostrado.
   */
  cgroupPeakMb?: number | null;
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

export type CollectionContinuity = "unknown" | "continuous" | "gapped";

export interface ContainerResourceSummary {
  name: string;
  /** Quantidade de amostras com uso de memória válido para este container. */
  samples: number;
  currentMb: number | null;
  /** Maior uso AMOSTRADO (uma leitura por tick), não o pico real do cgroup. */
  sampledPeakMb: number | null;
  /** Alias histórico de `sampledPeakMb` (compatibilidade). */
  peakMb: number | null;
  /** Pico real do cgroup, quando disponível. null = não medido. */
  cgroupPeakMb: number | null;
  averageMb: number | null;
  /** Último limite válido observado para o container. */
  limitMb: number | null;
  /** epoch ms da primeira amostra válida do container. */
  firstSampleAt: number | null;
  /** epoch ms da última amostra válida do container. */
  lastSampleAt: number | null;
  /** Idade da última amostra do CONTAINER (não do histórico global). */
  lastSampleAgeMs: number | null;
  /** Janela efetivamente coberta pelo container. */
  windowMs: number;
  /** Maior intervalo entre duas amostras válidas do container. */
  maxGapMs: number | null;
  /** Quantidade de intervalos acima do limite de continuidade. */
  gapCount: number;
  continuity: CollectionContinuity;
  /** ID do container na amostra mais recente (quando disponível). */
  containerId: string | null;
  /** true quando TODAS as amostras válidas têm containerId conhecido. */
  identityKnown: boolean;
  /** true quando o container foi recriado durante a janela observada. */
  identityChanged: boolean;
  /** true quando o limite observado mudou durante a janela. */
  limitChanged: boolean;
}

export interface ResourceHistorySummary {
  /** Quantidade de amostras válidas do container consultado. */
  samples: number;
  /** Janela do container consultado (não do histórico global). */
  windowMs: number;
  /** Idade da última amostra do container consultado. */
  lastSampleAgeMs: number | null;
  container: ContainerResourceSummary | null;
  host: {
    minMemAvailableMb: number | null;
    maxSwapActivityPages: number | null;
    maxSwapUsedMb: number | null;
    maxPsiSome10: number | null;
    maxPsiFull10: number | null;
  };
}

export type HistoryConfidence = "none" | "low" | "medium" | "high";

/** Intervalo esperado entre amostras do coletor. */
export const DEFAULT_SAMPLE_INTERVAL_MS = 60_000;
/** Lacuna acima disso quebra a continuidade (dois ticks perdidos). */
export const MAX_CONTINUOUS_GAP_MS = 2 * 60_000;

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
   * Resumo EXCLUSIVAMENTE do container consultado.
   *
   * A idade, janela, continuidade, pico e identidade vêm apenas das amostras
   * em que ESTE container apareceu com uso de memória válido. Uma amostra
   * recente de outro container não pode "rejuvenescer" o histórico deste.
   */
  summary(containerName: string, now = Date.now()): ResourceHistorySummary {
    this.prune(now);

    const entries = this.samples
      .map((sample) => ({
        at: sample.at,
        container: sample.containers.find((container) => container.name === containerName),
      }))
      .filter(
        (entry): entry is { at: number; container: ContainerResourceSample } =>
          Boolean(entry.container) &&
          typeof entry.container?.usageMb === "number" &&
          Number.isFinite(entry.container.usageMb),
      )
      .sort((a, b) => a.at - b.at);

    const values = entries.map((entry) => entry.container);
    const usages = values
      .map((container) => container.usageMb)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const limits = values
      .map((container) => container.limitMb)
      .filter((value): value is number => typeof value === "number" && value > 0);
    const cgroupPeaks = values
      .map((container) => container.cgroupPeakMb)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

    const first = entries.at(0) ?? null;
    const last = entries.at(-1) ?? null;
    const windowMs = first && last ? Math.max(0, last.at - first.at) : 0;
    const gaps = entries.slice(1).map((entry, index) => entry.at - entries[index].at);
    const maxGapMs = gaps.length > 0 ? Math.max(...gaps) : null;
    const gapCount = gaps.filter((gap) => gap > MAX_CONTINUOUS_GAP_MS).length;
    const continuity: CollectionContinuity =
      entries.length < 2 ? "unknown" : gapCount > 0 ? "gapped" : "continuous";

    const containerIds = values
      .map((container) => container.containerId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const uniqueContainerIds = new Set(containerIds);
    const identityKnown = entries.length > 0 && containerIds.length === entries.length;
    const identityChanged = uniqueContainerIds.size > 1;
    const uniqueLimits = new Set(limits);
    const limitChanged = uniqueLimits.size > 1;

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
    const swapUsed = this.samples
      .map((sample) => sample.swapUsedMb)
      .filter((value): value is number => value !== null);
    const psiSome = this.samples
      .map((sample) => sample.psiSome10)
      .filter((value): value is number => value !== null);
    const psiFull = this.samples
      .map((sample) => sample.psiFull10)
      .filter((value): value is number => value !== null);

    const container: ContainerResourceSummary | null =
      entries.length === 0
        ? null
        : {
            name: containerName,
            samples: entries.length,
            currentMb: usages.at(-1) ?? null,
            sampledPeakMb: usages.length > 0 ? Math.max(...usages) : null,
            peakMb: usages.length > 0 ? Math.max(...usages) : null,
            cgroupPeakMb: cgroupPeaks.length > 0 ? Math.max(...cgroupPeaks) : null,
            averageMb:
              usages.length > 0
                ? Math.round(usages.reduce((sum, value) => sum + value, 0) / usages.length)
                : null,
            limitMb: limits.length > 0 ? limits[limits.length - 1] : null,
            firstSampleAt: first?.at ?? null,
            lastSampleAt: last?.at ?? null,
            lastSampleAgeMs: last ? Math.max(0, now - last.at) : null,
            windowMs,
            maxGapMs,
            gapCount,
            continuity,
            containerId: containerIds.at(-1) ?? null,
            identityKnown,
            identityChanged,
            limitChanged,
          };

    return {
      samples: container?.samples ?? 0,
      windowMs: container?.windowMs ?? 0,
      lastSampleAgeMs: container?.lastSampleAgeMs ?? null,
      container,
      host: {
        minMemAvailableMb: memAvailable.length > 0 ? Math.min(...memAvailable) : null,
        maxSwapActivityPages: swapActivity.length > 0 ? Math.max(...swapActivity) : null,
        maxSwapUsedMb: swapUsed.length > 0 ? Math.max(...swapUsed) : null,
        maxPsiSome10: psiSome.length > 0 ? Math.max(...psiSome) : null,
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
                containerId: stringOrNull(container.containerId),
                cgroupPeakMb: numberOrNull(container.cgroupPeakMb),
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

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Qualidade do histórico, baseada EXCLUSIVAMENTE no container consultado.
 *
 * `high` NÃO autoriza deploy automático: significa apenas que há uma janela
 * longa, contínua, recente e com identidade conhecida. A capacidade real
 * ainda depende de perfil de build/staging, pisos e pressão do host.
 *
 * Regras atuais:
 * - `none`: sem amostras válidas do container.
 * - `low`: amostra antiga, lacuna > 2 min, identidade/limite mudou ou menos
 *   de 1 h de cobertura contínua.
 * - `medium`: >= 60 amostras e >= 1 h contínua.
 * - `high`: >= 720 amostras e >= 11 h contínua (buffer completo de 12 h).
 *   30 min de dados nunca chegam a `high`.
 */
export function classifyHistoryConfidence(
  summary: ResourceHistorySummary | null,
  params: {
    now?: number;
    maxAgeMs?: number;
    minSamples?: number;
    minWindowMs?: number;
    highMinSamples?: number;
    highMinWindowMs?: number;
  } = {},
): HistoryConfidence {
  const container = summary?.container;
  if (!container || container.samples === 0) return "none";

  const maxAgeMs = params.maxAgeMs ?? MAX_CONTINUOUS_GAP_MS;
  const minSamples = params.minSamples ?? 60;
  const minWindowMs = params.minWindowMs ?? 60 * 60 * 1000;
  const highMinSamples = params.highMinSamples ?? 720;
  const highMinWindowMs = params.highMinWindowMs ?? 11 * 60 * 60 * 1000;

  if (container.lastSampleAgeMs !== null && container.lastSampleAgeMs > maxAgeMs) return "low";
  if (container.continuity !== "continuous") return "low";
  if (!container.identityKnown || container.identityChanged || container.limitChanged) return "low";

  if (container.samples >= highMinSamples && container.windowMs >= highMinWindowMs) return "high";
  if (container.samples >= minSamples && container.windowMs >= minWindowMs) return "medium";
  return "low";
}
