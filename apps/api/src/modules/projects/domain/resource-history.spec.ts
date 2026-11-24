import {
  ResourceHistory,
  classifyHistoryConfidence,
  type ResourceSample,
} from "./resource-history";

/**
 * FASE A — histórico leve.
 *
 * Garante que o buffer é limitado, que o resumo reflete só as amostras do
 * container e que a confiança cai para "low"/"none" quando os dados estão
 * velhos ou ausentes — é isso que mantém a política adaptativa em fallback.
 */
const MINUTE = 60_000;
const NOW = Date.now();

function sample(overrides: Partial<ResourceSample> = {}): ResourceSample {
  return {
    at: NOW,
    memAvailableMb: 2370,
    memTotalMb: 4096,
    swapUsedMb: 723,
    swapInDelta: 0,
    swapOutDelta: 0,
    psiSome10: 0,
    psiFull10: 0,
    load1: 0.2,
    hostCpuPercent: 12,
    containers: [
      { name: "mesatta", usageMb: 386, limitMb: 1757, cpuPercent: 2 },
      { name: "evolution", usageMb: 120, limitMb: 512, cpuPercent: 1 },
    ],
    ...overrides,
  };
}

describe("ResourceHistory", () => {
  it("remove amostras velhas e mantém ordem cronológica", () => {
    const history = new ResourceHistory({ maxAgeMs: 10 * MINUTE, maxSamples: 10 });
    history.add(sample({ at: NOW - 20 * MINUTE }));
    history.add(sample({ at: NOW - 2 * MINUTE }));
    history.add(sample({ at: NOW }));

    history.prune(NOW);

    expect(history.all().map((entry) => entry.at)).toEqual([NOW - 2 * MINUTE, NOW]);
  });

  it("respeita maxSamples mantendo as mais recentes", () => {
    const history = new ResourceHistory({ maxAgeMs: 24 * 60 * MINUTE, maxSamples: 3 });
    for (let i = 0; i < 5; i += 1) {
      history.add(sample({ at: NOW - (4 - i) * MINUTE }));
    }

    expect(history.size()).toBe(3);
    expect(history.all().map((entry) => entry.at)).toEqual([
      NOW - 2 * MINUTE,
      NOW - MINUTE,
      NOW,
    ]);
  });

  it("resume consumo atual, pico e média do container + pior sinal do host", () => {
    const history = new ResourceHistory({ maxAgeMs: 24 * 60 * MINUTE, maxSamples: 100 });
    history.add(
      sample({
        at: NOW - 2 * MINUTE,
        containers: [{ name: "/mesatta", usageMb: 300, limitMb: 1757, cpuPercent: 1 }],
        memAvailableMb: 2500,
        swapInDelta: 10,
        swapOutDelta: 0,
        psiFull10: 0,
      }),
    );
    history.add(
      sample({
        at: NOW,
        containers: [{ name: "mesatta", usageMb: 386, limitMb: 1757, cpuPercent: 2 }],
        memAvailableMb: 2200,
        swapInDelta: 0,
        swapOutDelta: 40,
        psiFull10: 0.02,
      }),
    );

    const summary = history.summary("mesatta", NOW);

    expect(summary.samples).toBe(1);
    expect(summary.container).toMatchObject({
      name: "mesatta",
      currentMb: 386,
      peakMb: 386,
      averageMb: 386,
      limitMb: 1757,
    });
    expect(summary.host.minMemAvailableMb).toBe(2200);
    expect(summary.host.maxSwapActivityPages).toBe(40);
    expect(summary.host.maxPsiFull10).toBe(0.02);
    expect(summary.lastSampleAgeMs).toBe(0);
  });

  it("classifica confiança: sem dados, curto/velho, médio e alto", () => {
    const empty = new ResourceHistory();
    expect(classifyHistoryConfidence(empty.summary("mesatta", NOW), { now: NOW })).toBe("none");

    const short = new ResourceHistory({ maxAgeMs: 24 * 60 * MINUTE, maxSamples: 100 });
    short.add(sample({ at: NOW - 2 * MINUTE }));
    expect(classifyHistoryConfidence(short.summary("mesatta", NOW), { now: NOW })).toBe("low");

    const medium = new ResourceHistory({ maxAgeMs: 24 * 60 * MINUTE, maxSamples: 100 });
    for (let i = 0; i < 12; i += 1) medium.add(sample({ at: NOW - (12 - i) * MINUTE }));
    expect(classifyHistoryConfidence(medium.summary("mesatta", NOW), { now: NOW })).toBe("medium");

    const high = new ResourceHistory({ maxAgeMs: 24 * 60 * MINUTE, maxSamples: 100 });
    for (let i = 0; i < 40; i += 1) high.add(sample({ at: NOW - (40 - i) * MINUTE }));
    expect(classifyHistoryConfidence(high.summary("mesatta", NOW), { now: NOW })).toBe("high");
  });

  it("amostra antiga rebaixa a confiança mesmo com muitas amostras", () => {
    const history = new ResourceHistory({ maxAgeMs: 24 * 60 * MINUTE, maxSamples: 100 });
    for (let i = 0; i < 40; i += 1) history.add(sample({ at: NOW - 60 * MINUTE - i * MINUTE }));

    expect(classifyHistoryConfidence(history.summary("mesatta", NOW), { now: NOW })).toBe("low");
  });

  it("serializa e reconstrói sem aceitar lixo", () => {
    const history = new ResourceHistory({ maxAgeMs: 24 * 60 * MINUTE, maxSamples: 10 });
    history.add(sample({ at: NOW }));

    const restored = ResourceHistory.fromJSON(history.toJSON());
    expect(restored.size()).toBe(1);
    expect(restored.summary("mesatta", NOW).container?.peakMb).toBe(386);

    const invalid = ResourceHistory.fromJSON({
      samples: [{ at: "ontem" }, null, { at: NOW, containers: "nope" }],
    });
    expect(invalid.size()).toBe(1);
    expect(invalid.all()[0].containers).toEqual([]);
  });
});
