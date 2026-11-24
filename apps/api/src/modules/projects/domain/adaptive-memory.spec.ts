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

function summary(overrides: Partial<ResourceHistorySummary> = {}): ResourceHistorySummary {
  return {
    samples: 40,
    windowMs: 39 * MINUTE,
    lastSampleAgeMs: MINUTE,
    container: {
      name: "mesatta",
      samples: 40,
      currentMb: 386,
      peakMb: 386,
      averageMb: 380,
      limitMb: 1757,
    },
    host: {
      minMemAvailableMb: 2300,
      maxSwapActivityPages: 0,
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
      summary: summary({ samples: 3, container: { ...summary().container!, samples: 3 } }),
      currentRequiredMb: CONSERVATIVE,
      now: NOW,
    });
    expect(short.basis).toBe("conservative-fallback");
    expect(short.savedMb).toBe(0);
    expect(short.reason).toMatch(/insuficiente/);

    const stale = computeAdaptiveBuildMemoryRequirement({
      params: PARAMS,
      summary: summary({ lastSampleAgeMs: 60 * MINUTE }),
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
      summary: summary({ container: { ...summary().container!, peakMb: 568 } }),
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
      summary: summary({ container: { ...summary().container!, peakMb: 1700 } }),
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
      summary: summary({ container: { ...summary().container!, peakMb: 100 } }),
      currentRequiredMb: 2395,
      now: NOW,
    });

    // crescimento 0 -> reserva estrutural 1024 + 256 + 768 = 2048.
    expect(result.requiredMb).toBe(2048);
    expect(result.requiredMb).toBeGreaterThanOrEqual(PARAMS.buildRequirementMb);
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
