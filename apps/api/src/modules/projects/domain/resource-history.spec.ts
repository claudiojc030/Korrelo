import {
  ResourceHistory,
  MAX_CONTINUOUS_GAP_MS,
  classifyHistoryConfidence,
  type ResourceSample,
} from "./resource-history";

/**
 * FASE A — histórico leve.
 *
 * Garante que o buffer é limitado, que o resumo reflete só as amostras do
 * container e que a confiança cai para "low"/"none" quando os dados estão
 * velhos, descontínuos ou de versões diferentes.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
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
      {
        name: "mesatta",
        usageMb: 386,
        limitMb: 1757,
        cpuPercent: 2,
        containerId: "container-a",
        cgroupPeakMb: null,
      },
      {
        name: "evolution",
        usageMb: 120,
        limitMb: 512,
        cpuPercent: 1,
        containerId: "container-b",
        cgroupPeakMb: null,
      },
    ],
    ...overrides,
  };
}

function addSeries(history: ResourceHistory, count: number, stepMs = MINUTE, from = NOW): void {
  for (let i = 0; i < count; i += 1) {
    history.add(sample({ at: from - (count - 1 - i) * stepMs }));
  }
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
    const history = new ResourceHistory({ maxAgeMs: 24 * HOUR, maxSamples: 3 });
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

  it("resume consumo atual, pico amostrado, cgroup e pior sinal do host", () => {
    const history = new ResourceHistory({ maxAgeMs: 24 * HOUR, maxSamples: 100 });
    history.add(
      sample({
        at: NOW - 2 * MINUTE,
        containers: [
          {
            name: "/mesatta",
            usageMb: 300,
            limitMb: 1757,
            cpuPercent: 1,
            containerId: "old-name",
            cgroupPeakMb: null,
          },
        ],
        memAvailableMb: 2500,
        swapInDelta: 10,
        swapOutDelta: 0,
        psiFull10: 0,
      }),
    );
    history.add(
      sample({
        at: NOW,
        containers: [
          {
            name: "mesatta",
            usageMb: 386,
            limitMb: 1757,
            cpuPercent: 2,
            containerId: "container-a",
            cgroupPeakMb: 900,
          },
        ],
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
      samples: 1,
      currentMb: 386,
      sampledPeakMb: 386,
      peakMb: 386,
      cgroupPeakMb: 900,
      averageMb: 386,
      limitMb: 1757,
      containerId: "container-a",
      identityKnown: true,
      identityChanged: false,
      limitChanged: false,
    });
    expect(summary.host.minMemAvailableMb).toBe(2200);
    expect(summary.host.maxSwapActivityPages).toBe(40);
    expect(summary.host.maxPsiFull10).toBe(0.02);
    expect(summary.lastSampleAgeMs).toBe(0);
  });

  it("mede idade e janela do CONTAINER, não do histórico global", () => {
    const history = new ResourceHistory({ maxAgeMs: 24 * HOUR, maxSamples: 200 });
    for (let i = 40; i >= 1; i -= 1) {
      history.add(sample({ at: NOW - i * MINUTE }));
    }
    // Outro container tem uma amostra recente; isso não pode rejuvenescer o
    // histórico do Mesatta.
    history.add(
      sample({
        at: NOW,
        containers: [
          {
            name: "evolution",
            usageMb: 120,
            limitMb: 512,
            cpuPercent: 1,
            containerId: "container-b",
            cgroupPeakMb: null,
          },
        ],
      }),
    );

    const summary = history.summary("mesatta", NOW);

    expect(summary.container?.samples).toBe(40);
    expect(summary.container?.lastSampleAt).toBe(NOW - MINUTE);
    expect(summary.container?.lastSampleAgeMs).toBe(MINUTE);
    expect(summary.lastSampleAgeMs).toBe(MINUTE);
    expect(summary.container?.windowMs).toBe(39 * MINUTE);
    expect(summary.container?.continuity).toBe("continuous");
    expect(classifyHistoryConfidence(summary, { now: NOW })).toBe("low");
  });

  it("não há confiança none sem histórico e 30 min não chegam a high", () => {
    const empty = new ResourceHistory();
    expect(classifyHistoryConfidence(empty.summary("mesatta", NOW), { now: NOW })).toBe("none");

    const thirty = new ResourceHistory({ maxAgeMs: 24 * HOUR, maxSamples: 2000 });
    addSeries(thirty, 30);
    expect(classifyHistoryConfidence(thirty.summary("mesatta", NOW), { now: NOW })).toBe("low");

    const oneHour = new ResourceHistory({ maxAgeMs: 24 * HOUR, maxSamples: 2000 });
    addSeries(oneHour, 61);
    expect(classifyHistoryConfidence(oneHour.summary("mesatta", NOW), { now: NOW })).toBe("medium");

    const full = new ResourceHistory({ maxAgeMs: 24 * HOUR, maxSamples: 2000 });
    addSeries(full, 720);
    expect(classifyHistoryConfidence(full.summary("mesatta", NOW), { now: NOW })).toBe("high");
  });

  it("amostra antiga rebaixa a confiança mesmo com muitas amostras", () => {
    const history = new ResourceHistory({ maxAgeMs: 24 * HOUR, maxSamples: 2000 });
    for (let i = 0; i < 720; i += 1) {
      history.add(sample({ at: NOW - 3 * MINUTE - (719 - i) * MINUTE }));
    }

    expect(classifyHistoryConfidence(history.summary("mesatta", NOW), { now: NOW })).toBe("low");
  });

  it("lacuna acima de dois minutos quebra a continuidade e rebaixa a confiança", () => {
    const history = new ResourceHistory({ maxAgeMs: 24 * HOUR, maxSamples: 2000 });
    history.add(sample({ at: NOW - 4 * MINUTE }));
    history.add(sample({ at: NOW - 3 * MINUTE }));
    history.add(sample({ at: NOW - 7 * MINUTE }));

    const summary = history.summary("mesatta", NOW);

    expect(summary.container?.gapCount).toBeGreaterThan(0);
    expect(summary.container?.maxGapMs).toBeGreaterThan(MAX_CONTINUOUS_GAP_MS);
    expect(summary.container?.continuity).toBe("gapped");
    expect(classifyHistoryConfidence(summary, { now: NOW })).toBe("low");
  });

  it("container recriado ou limite alterado reduz a confiança", () => {
    const recreated = new ResourceHistory({ maxAgeMs: 24 * HOUR, maxSamples: 2000 });
    for (let i = 0; i < 720; i += 1) {
      recreated.add(
        sample({
          at: NOW - (719 - i) * MINUTE,
          containers: [
            {
              name: "mesatta",
              usageMb: 386,
              limitMb: 1757,
              cpuPercent: 2,
              containerId: i < 360 ? "container-old" : "container-new",
              cgroupPeakMb: 800,
            },
          ],
        }),
      );
    }
    const recreatedSummary = recreated.summary("mesatta", NOW);
    expect(recreatedSummary.container?.identityChanged).toBe(true);
    expect(recreatedSummary.container?.sampledPeakMb).toBeNull();
    expect(recreatedSummary.container?.peakMb).toBeNull();
    expect(recreatedSummary.container?.cgroupPeakMb).toBeNull();
    expect(classifyHistoryConfidence(recreatedSummary, { now: NOW })).toBe("low");

    const limitChanged = new ResourceHistory({ maxAgeMs: 24 * HOUR, maxSamples: 2000 });
    for (let i = 0; i < 720; i += 1) {
      limitChanged.add(
        sample({
          at: NOW - (719 - i) * MINUTE,
          containers: [
            {
              name: "mesatta",
              usageMb: 386,
              limitMb: i < 360 ? 1757 : 1024,
              cpuPercent: 2,
              containerId: "container-a",
              cgroupPeakMb: null,
            },
          ],
        }),
      );
    }
    const limitSummary = limitChanged.summary("mesatta", NOW);
    expect(limitSummary.container?.limitChanged).toBe(true);
    expect(classifyHistoryConfidence(limitSummary, { now: NOW })).toBe("low");
  });

  it("pico curto só é conhecido quando o cgroup fornece memory.peak", () => {
    const history = new ResourceHistory({ maxAgeMs: 24 * HOUR, maxSamples: 100 });
    history.add(
      sample({
        at: NOW,
        containers: [
          {
            name: "mesatta",
            usageMb: 386,
            limitMb: 1757,
            cpuPercent: 2,
            containerId: "container-a",
            cgroupPeakMb: 1200,
          },
        ],
      }),
    );

    const summary = history.summary("mesatta", NOW);
    expect(summary.container?.sampledPeakMb).toBe(386);
    expect(summary.container?.cgroupPeakMb).toBe(1200);
  });

  it("não inventa pico de cgroup quando a leitura falha", () => {
    const history = new ResourceHistory({ maxAgeMs: 24 * HOUR, maxSamples: 100 });
    history.add(
      sample({
        at: NOW,
        containers: [
          {
            name: "mesatta",
            usageMb: 386,
            limitMb: 1757,
            cpuPercent: 2,
            containerId: "container-a",
            cgroupPeakMb: null,
          },
        ],
      }),
    );

    const summary = history.summary("mesatta", NOW);
    expect(summary.container?.cgroupPeakMb).toBeNull();
    expect(summary.container?.sampledPeakMb).toBe(386);
  });

  it("histórico antigo sem identidade não recebe confiança high", () => {
    const now = Date.now();
    const samples = Array.from({ length: 720 }, (_, i) => ({
      at: now - (719 - i) * MINUTE,
      memAvailableMb: 2370,
      memTotalMb: 4096,
      swapUsedMb: 0,
      swapInDelta: 0,
      swapOutDelta: 0,
      psiSome10: 0,
      psiFull10: 0,
      load1: 0.2,
      hostCpuPercent: 12,
      // Formato antigo: sem containerId e sem cgroupPeakMb.
      containers: [{ name: "mesatta", usageMb: 386, limitMb: 1757, cpuPercent: 2 }],
    }));

    const restored = ResourceHistory.fromJSON({ version: 1, samples });
    const summary = restored.summary("mesatta", now);

    expect(summary.container?.identityKnown).toBe(false);
    expect(summary.container?.containerId).toBeNull();
    expect(summary.container?.cgroupPeakMb).toBeNull();
    expect(classifyHistoryConfidence(summary, { now })).toBe("low");
  });

  it("serializa e reconstrói sem aceitar lixo", () => {
    const history = new ResourceHistory({ maxAgeMs: 24 * HOUR, maxSamples: 10 });
    history.add(sample({ at: NOW }));

    const restored = ResourceHistory.fromJSON(history.toJSON());
    expect(restored.size()).toBe(1);
    expect(restored.summary("mesatta", NOW).container).toMatchObject({
      peakMb: 386,
      containerId: "container-a",
      cgroupPeakMb: null,
    });

    const invalid = ResourceHistory.fromJSON({
      samples: [{ at: "ontem" }, null, { at: NOW, containers: "nope" }],
    });
    expect(invalid.size()).toBe(1);
    expect(invalid.all()[0].containers).toEqual([]);
  });
});
