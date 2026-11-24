/**
 * POLÍTICA ADAPTATIVA DE MEMÓRIA (Resource Manager V1 — Fase B, SOMBRA).
 *
 * Substitui o "crescimento até o limite histórico" pelo "pico realmente
 * observado + margem" quando existe histórico confiável. Em qualquer dúvida
 * (sem histórico, curto, antigo, coletor falhou) devolve exatamente a
 * política conservadora atual.
 *
 * IMPORTANTE (Fase B): este cálculo é SOMENTE SIMULAÇÃO. O preflight continua
 * decidindo com `computeBuildMemoryRequirementMb`; o resultado adaptativo só é
 * exposto para comparação. Ativar as decisões é Fase C, após evidência em
 * produção. A "confiança" descreve a quantidade/idade das amostras - como o
 * coletor amostra a cada 60 s, ela NÃO é garantia de que um pico curto será
 * capturado.
 */
import type { ResourceHistorySummary } from "./resource-history";
import { classifyHistoryConfidence, type HistoryConfidence } from "./resource-history";
import {
  computeBuildMemoryRequirementMb,
  type BuildMemoryRequirementParams,
} from "../../../infrastructure/host-resources";

/** Intervalo de amostragem do coletor de métricas (segundos). */
const SAMPLING_INTERVAL_SECONDS = 60;

/** Quanto acima do pico observado a reserva cobre (picos não vistos). */
const PEAK_SAFETY_FACTOR = 1.25;

export interface AdaptiveMemoryInput {
  params: BuildMemoryRequirementParams;
  summary: ResourceHistorySummary | null;
  currentRequiredMb: number;
  now?: number;
}

export interface AdaptiveMemoryResult {
  /** Nome do cálculo que produziu `requiredMb`. */
  basis: "conservative-fallback" | "observed-peak";
  /** Sempre preenchido; igual ao conservador quando `basis` é fallback. */
  requiredMb: number;
  conservativeRequiredMb: number;
  /** Economia potencial (conservador − adaptativo); 0 no fallback. */
  savedMb: number;
  /**
   * Qualidade dos dados observados. NÃO é garantia de segurança: o coletor
   * amostra a cada 60 s e picos curtos podem não aparecer.
   */
  confidence: HistoryConfidence;
  samples: number;
  windowMs: number;
  /** Intervalo de amostragem usado como base (60 s). */
  samplingIntervalSeconds: number;
  currentUsageMb: number | null;
  observedPeakMb: number | null;
  /** Motivo curto quando caiu no fallback. */
  reason: string | null;
  /**
   * Fase B: resultado apenas SIMULADO. Nunca é usado para decidir o deploy;
   * `shadowOnly` é mantido por compatibilidade com consumidores antigos.
   */
  simulation: true;
  shadowOnly: true;
}

/**
 * Política adaptativa:
 *
 *   crescimentoReservado = min(
 *     headroomConservador,                 // limite − uso (política atual)
 *     picoObservado × 1,25 − usoAtual      // pico real + 25%
 *   )
 *   requiredAdaptativo = max(
 *     pisoDoHost,
 *     max(build, crescimentoReservado) + margem + staging
 *   )
 *
 * O piso estrutural (build + margem + staging) permanece; PSI, swap e load
 * continuam sendo gates separados e não são tocados aqui.
 */
export function computeAdaptiveBuildMemoryRequirement(input: AdaptiveMemoryInput): AdaptiveMemoryResult {
  const { params, summary, currentRequiredMb } = input;
  const now = input.now ?? Date.now();
  const confidence = classifyHistoryConfidence(summary, { now });
  const usage = params.productionUsageMb;
  const conservativeHeadroom = Math.max(
    0,
    params.productionLimitMb - (typeof usage === "number" && Number.isFinite(usage) ? usage : 0),
  );

  const fallback = (reason: string): AdaptiveMemoryResult => ({
    basis: "conservative-fallback",
    requiredMb: currentRequiredMb,
    conservativeRequiredMb: currentRequiredMb,
    savedMb: 0,
    confidence,
    samples: summary?.samples ?? 0,
    windowMs: summary?.windowMs ?? 0,
    samplingIntervalSeconds: SAMPLING_INTERVAL_SECONDS,
    currentUsageMb: typeof usage === "number" && Number.isFinite(usage) ? usage : null,
    observedPeakMb: summary?.container?.peakMb ?? null,
    reason,
    simulation: true,
    shadowOnly: true,
  });

  if (!summary || !summary.container || summary.container.samples === 0) {
    return fallback("sem histórico do container de produção");
  }
  if (confidence === "none" || confidence === "low") {
    return fallback(`histórico insuficiente ou desatualizado (${confidence})`);
  }
  if (summary.lastSampleAgeMs !== null && summary.lastSampleAgeMs > 10 * 60 * 1000) {
    return fallback("última amostra antiga");
  }

  const peak = summary.container.peakMb;
  if (peak === null || !Number.isFinite(peak)) {
    return fallback("pico observado indisponível");
  }

  const usageKnown = typeof usage === "number" && Number.isFinite(usage) && usage >= 0;
  const usageCurrent = usageKnown ? Math.max(0, usage as number) : null;
  const baseline = Math.max(peak, usageCurrent ?? 0);
  // Sem uso atual conhecido, o histórico ainda permite uma projeção, mas o
  // cálculo conservador (que usa o limite inteiro) é mais seguro: mantemos o
  // fallback até a medição atual voltar.
  if (usageCurrent === null) {
    return fallback("uso atual da produção indisponível");
  }

  const projectedPeak = Math.ceil(baseline * PEAK_SAFETY_FACTOR);
  const observedGrowth = Math.max(0, projectedPeak - usageCurrent);
  const adaptiveHeadroom = Math.min(conservativeHeadroom, observedGrowth);
  const adaptiveRequired = computeBuildMemoryRequirementMb({
    ...params,
    // Mesmo com headroom pequeno, `computeBuildMemoryRequirementMb` mantém o
    // piso do build e a soma de margem/staging. O máximo com o valor atual
    // garante que a sombra nunca fique abaixo da conta conservadora por
    // arredondamento — a economia vem só do headroom.
    productionUsageMb: Math.max(0, params.productionLimitMb - adaptiveHeadroom),
  }).requiredMb;

  return {
    basis: "observed-peak",
    requiredMb: Math.min(currentRequiredMb, adaptiveRequired),
    conservativeRequiredMb: currentRequiredMb,
    savedMb: Math.max(0, currentRequiredMb - Math.min(currentRequiredMb, adaptiveRequired)),
    confidence,
    samples: summary.samples,
    windowMs: summary.windowMs,
    samplingIntervalSeconds: SAMPLING_INTERVAL_SECONDS,
    currentUsageMb: usageCurrent,
    observedPeakMb: peak,
    reason: null,
    simulation: true,
    shadowOnly: true,
  };
}
