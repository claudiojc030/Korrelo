import type { ResourceHistorySummary } from "./resource-history";
import { computeAdaptiveBuildMemoryRequirement } from "./adaptive-memory";
import type { BuildMemoryRequirementParams } from "../../../infrastructure/host-resources";

/**
 * FASE B — política adaptativa em SOMBRA.
 *
 * A regra de ouro: qualquer incerteza (sem histórico, curto, antigo, uso
 * atual desconhecido) devolve EXATAMENTE a política conservadora. Quando há
 * evidência, a economia vem só de substituir "crescimento até o limite" pelo
 * "pico observado + 25%".
 */
const MINUTE = 60_000;
const WINDOW_MS = 11 * 60 * MINUTE;
const NOW = 1_700_000_000_000;

const PARAMS: BuildMemoryRequirementParams = {
  hostFloorMb: 1200,
  buildRequirementMb: 1024,
  safetyMarginMb: 256,
  stagingReservationMb: 768,
  productionLimitMb: 1757,
  productionUsageMb: 386,
};

/** 386 + 1371 de headroom + 256 + 768 = 2395 (cenário atual do Mesatta). */
const CONSERVATIVE = 2395;

function summary(
  overrides: Partial<ResourceHistorySummary> = {},
  containerOverrides: Partial<NonNullable<ResourceHistorySummary["container"]>> = {},
): ResourceHistorySummary {
  return {
    samples: 720,
    windowMs: WINDOW_MS,
    lastSampleAgeMs: MINUTE,
    container: {
      name: "mesatta",
      samples: 720,
      currentMb: 386,
      sampledPeakMb: 386,
      peakMb: 386,
      cgroupPeakMb: null,
      averageMb: 380,
      limitMb: 1757,
      firstSampleAt: NOW - WINDOW_MS - MINUTE,
      lastSampleAt: NOW - MINUTE,
      lastSampleAgeMs: MINUTE,
      windowMs: WINDOW_MS,
      maxGapMs: MINUTE,
      gapCount: 0,
      continuity: "continuous",
      containerId: "container-a",
      identityKnown: true,
      identityChanged: false,
      limitChanged: false,
      ...containerOverrides,
    },
    host: {
      minMemAvailableMb: 2300,
      maxSwapActivityPages: 0,
      maxSwapUsedMb: 0,
      maxPsiSome10: 0,
      maxPsiFull10: 0,
    },
    ...overrides,
  };
}

describe("computeAdaptiveBuildMemoryRequirement (sombra)", () => {
  it("sem histórico: fallback idêntico ao conservador", () => {
    const result = computeAdaptiveBuildMemoryRequirement({
      params: PARAMS,
      summary: null,
      currentRequiredMb: CONSERVATIVE,
      now: NOW,
    });

    expect(result.basis).toBe("conservative-fallback");
    expect(result.requiredMb).toBe(CONSERVATIVE);
    expect(result.savedMb).toBe(0);
    expect(result.reason).toMatch(/sem histórico/);
    expect(result.simulation).toBe(true);
    expect(result.shadowOnly).toBe(true);
    expect(result.samplingIntervalSeconds).toBe(60);
  });

  it("histórico curto ou antigo mantém o fallback", () => {
    const short = computeAdaptiveBuildMemoryRequirement({
      params: PARAMS,
      summary: summary(
        { samples: 3, windowMs: 3 * MINUTE },
        { samples: 3, windowMs: 3 * MINUTE, continuity: "unknown", lastSampleAgeMs: MINUTE },
      ),
      currentRequiredMb: CONSERVATIVE,
      now: NOW,
    });
    expect(short.basis).toBe("conservative-fallback");
    expect(short.savedMb).toBe(0);
    expect(short.reason).toMatch(/insuficiente/);

    const stale = computeAdaptiveBuildMemoryRequirement({
      params: PARAMS,
      summary: summary({ lastSampleAgeMs: 60 * MINUTE }, { lastSampleAgeMs: 60 * MINUTE }),
      currentRequiredMb: CONSERVATIVE,
      now: NOW,
    });
    expect(stale.basis).toBe("conservative-fallback");
  });

  it("uso atual desconhecido mantém o fallback (nunca assume zero)", () => {
    const result = computeAdaptiveBuildMemoryRequirement({
      params: { ...PARAMS, productionUsageMb: null },
      summary: summary(),
      currentRequiredMb: CONSERVATIVE,
      now: NOW,
    });

    expect(result.basis).toBe("conservative-fallback");
    expect(result.requiredMb).toBe(CONSERVATIVE);
    expect(result.reason).toMatch(/uso atual/);
  });

  it("pico observado abaixo do headroom reduz a reserva (mesmo build/margem/staging)", () => {
    const result = computeAdaptiveBuildMemoryRequirement({
      params: PARAMS,
      summary: summary({}, { sampledPeakMb: 568, peakMb: 568 }),
      currentRequiredMb: CONSERVATIVE,
      now: NOW,
    });

    // 568 * 1,25 = 710; crescimento = 710 - 386 = 324; como 324 < 1371,
    // a reserva vira 324 -> 1024 + 256 + 768 = 2048.
    expect(result.basis).toBe("observed-peak");
    expect(result.requiredMb).toBe(2048);
    expect(result.savedMb).toBe(CONSERVATIVE - 2048);
    expect(result.confidence).toBe("high");
    expect(result.observedPeakMb).toBe(568);
  });

  it("pico próximo do limite não economiza: o headroom conservador manda", () => {
    const result = computeAdaptiveBuildMemoryRequirement({
      params: PARAMS,
      summary: summary({}, { sampledPeakMb: 1700, peakMb: 1700 }),
      currentRequiredMb: CONSERVATIVE,
      now: NOW,
    });

    // 1700*1,25 = 2125; crescimento = 1739 > headroom 1371 -> mesmo requisito.
    expect(result.basis).toBe("observed-peak");
    expect(result.requiredMb).toBe(CONSERVATIVE);
    expect(result.savedMb).toBe(0);
  });

  it("pico zero/uso maior que o pico nunca cai abaixo do piso estrutural", () => {
    const result = computeAdaptiveBuildMemoryRequirement({
      params: { ...PARAMS, productionUsageMb: 700 },
      summary: summary({}, { sampledPeakMb: 100, peakMb: 100 }),
      currentRequiredMb: 2395,
      now: NOW,
    });

    // crescimento 0 -> reserva estrutural 1024 + 256 + 768 = 2048.
    expect(result.requiredMb).toBe(2048);
    expect(result.requiredMb).toBeGreaterThanOrEqual(PARAMS.buildRequirementMb);
  });

  it("pico real do cgroup tem precedência sobre o pico amostrado", () => {
    const result = computeAdaptiveBuildMemoryRequirement({
      params: PARAMS,
      summary: summary({}, { sampledPeakMb: 386, peakMb: 386, cgroupPeakMb: 900 }),
      currentRequiredMb: CONSERVATIVE,
      now: NOW,
    });

    expect(result.basis).toBe("observed-peak");
    expect(result.observedPeakMb).toBe(900);
    expect(result.peakSource).toBe("cgroup");
  });

  it("cgroup menor que o amostrado (reset) não reduz o pico observado", () => {
    const result = computeAdaptiveBuildMemoryRequirement({
      params: PARAMS,
      summary: summary({}, { sampledPeakMb: 1000, peakMb: 1000, cgroupPeakMb: 500 }),
      currentRequiredMb: CONSERVATIVE,
      now: NOW,
    });

    expect(result.observedPeakMb).toBe(1000);
    expect(result.peakSource).toBe("sampled");
  });

  it("container recriado ou limite alterado mantém o fallback conservador", () => {
    const recreated = computeAdaptiveBuildMemoryRequirement({
      params: PARAMS,
      summary: summary({}, { identityChanged: true }),
      currentRequiredMb: CONSERVATIVE,
      now: NOW,
    });
    expect(recreated.basis).toBe("conservative-fallback");
    expect(recreated.reason).toMatch(/recriado/);

    const limitChanged = computeAdaptiveBuildMemoryRequirement({
      params: PARAMS,
      summary: summary({}, { limitChanged: true }),
      currentRequiredMb: CONSERVATIVE,
      now: NOW,
    });
    expect(limitChanged.basis).toBe("conservative-fallback");
    expect(limitChanged.reason).toMatch(/limite/);

    const unknownIdentity = computeAdaptiveBuildMemoryRequirement({
      params: PARAMS,
      summary: summary({}, { identityKnown: false }),
      currentRequiredMb: CONSERVATIVE,
      now: NOW,
    });
    expect(unknownIdentity.basis).toBe("conservative-fallback");
  });

  it("nunca devolve valor acima do conservador (sombra só pode economizar)", () => {
    const result = computeAdaptiveBuildMemoryRequirement({
      params: PARAMS,
      summary: summary(),
      currentRequiredMb: 1500,
      now: NOW,
    });
    expect(result.requiredMb).toBeLessThanOrEqual(1500);
  });
});
