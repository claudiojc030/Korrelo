/**
 * SWAP HISTÓRICA x PRESSÃO DE MEMÓRIA REAL.
 *
 * Incidente real: no rollout, o `npm ci` deixou 601 MB de swap em uso (limite
 * 512 MB) e o rollout ficou 180 s esperando, depois abortou - apesar de:
 *   - MemAvailable ≈ 2648 MB (confortável);
 *   - load baixo (0.13);
 *   - CPU ociosa (95-98%);
 *   - si/so = 0 (nenhuma atividade de swap);
 *   - PSI memory some/full = 0.00 (nenhuma pressão);
 *   - disco OK.
 *
 * Causa: o guard usava a swap usada TOTAL como bloqueio absoluto. O Linux
 * mantém páginas antigas em swap mesmo depois da pressão passar - swap
 * usada alta, sozinha, NÃO é pressão atual.
 *
 * Agora a decisão usa MemAvailable + load + disco + (atividade de swap +
 * PSI). A swap usada continua sendo registrada e exibida, mas como sinal
 * auxiliar.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodePath = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const guard = require(nodePath.join(
  nodePath.resolve(__dirname, "..", "..", "..", "scripts", "rollout", "lib"),
  "resource-guard.cjs",
));

const THRESHOLDS = guard.readThresholds({});

/** Recursos base (host saudável, como na VPS do incidente). */
function baseResources(overrides: Record<string, unknown> = {}) {
  return {
    memAvailableMb: 2648,
    memTotalMb: 3915,
    swapUsedMb: 601,
    swapTotalMb: 2047,
    load1: 0.13,
    load5: 0.12,
    load15: 0.1,
    diskAvailableGb: 26.9,
    diskTotalGb: 40,
    swapActivity: { available: true, swapInDelta: 0, swapOutDelta: 0 },
    memoryPressure: { available: true, someAvg10: 0, fullAvg10: 0 },
    measurable: true,
    ...overrides,
  };
}

function evaluate(resources: Record<string, unknown>) {
  return guard.evaluateResources({ resources, thresholds: THRESHOLDS });
}

describe("rollout - swap histórica não bloqueia o build; pressão real bloqueia", () => {
  it("1) caso REAL da VPS (2648 MB livres, 601 MB de swap, si/so 0, PSI 0) -> SAFE", () => {
    const result = evaluate(baseResources());

    expect(result.safeToBuild).toBe(true);
    expect(result.checks.find((c: { name: string }) => c.name === "swap em uso")?.ok).toBe(true);
  });

  it("2) swap alta histórica, sem atividade -> SAFE (e vira contexto)", () => {
    const result = evaluate(
      baseResources({
        swapUsedMb: 1800,
        swapActivity: { available: true, swapInDelta: 0, swapOutDelta: 0 },
        memoryPressure: { available: true, someAvg10: 0, fullAvg10: 0 },
      }),
    );

    expect(result.safeToBuild).toBe(true);
    const swap = result.checks.find((c: { name: string }) => c.name === "swap em uso");
    expect(swap?.ok).toBe(true);
    // O histórico fica registrado como diagnóstico.
    expect(String(swap?.detail)).toContain("swap histórica");
  });

  it("3) swap-out ATIVO -> UNSAFE", () => {
    const result = evaluate(
      baseResources({
        swapActivity: { available: true, swapInDelta: 0, swapOutDelta: 900 },
      }),
    );

    expect(result.safeToBuild).toBe(false);
    expect(String(result.reason)).toContain("swap em uso");
  });

  it("4) swap-in ATIVO -> UNSAFE", () => {
    const result = evaluate(
      baseResources({
        swapActivity: { available: true, swapInDelta: 750, swapOutDelta: 0 },
      }),
    );

    expect(result.safeToBuild).toBe(false);
  });

  it("5) PSI de memória (some avg10) alto -> UNSAFE", () => {
    const result = evaluate(
      baseResources({
        memoryPressure: { available: true, someAvg10: 4.2, fullAvg10: 0 },
      }),
    );

    expect(result.safeToBuild).toBe(false);
  });

  it("6) PSI de memória (full avg10) acima de 0 -> UNSAFE", () => {
    const result = evaluate(
      baseResources({
        memoryPressure: { available: true, someAvg10: 0, fullAvg10: 0.05 },
      }),
    );

    expect(result.safeToBuild).toBe(false);
  });

  it("7) RAM abaixo do mínimo -> UNSAFE mesmo com PSI 0 e swap sem atividade", () => {
    const result = evaluate(baseResources({ memAvailableMb: 700 }));

    expect(result.safeToBuild).toBe(false);
    expect(String(result.reason)).toContain("memória disponível");
  });

  it("8) load acima do limite -> UNSAFE", () => {
    const result = evaluate(baseResources({ load1: 2.4 }));

    expect(result.safeToBuild).toBe(false);
    expect(String(result.reason)).toContain("load average");
  });

  it("9) PSI indisponível: não quebra e usa fallback conservador", () => {
    const result = evaluate(
      baseResources({
        memoryPressure: { available: false, someAvg10: null, fullAvg10: null },
        swapActivity: { available: true, swapInDelta: 0, swapOutDelta: 0 },
      }),
    );

    // A atividade de swap (disponível e zerada) basta para liberar.
    expect(result.safeToBuild).toBe(true);

    // Sem NENHUM sinal (host sem /proc): conservador -> bloqueia.
    const blind = evaluate(
      baseResources({
        memoryPressure: { available: false, someAvg10: null, fullAvg10: null },
        swapActivity: { available: false, swapInDelta: null, swapOutDelta: null },
      }),
    );
    expect(blind.safeToBuild).toBe(false);
  });

  it("10) /proc/vmstat inválido: não quebra, diagnóstico claro e fallback conservador", () => {
    // Parser: entrada incompleta/quebrada -> null (sem exceção).
    expect(guard.parseVmstat("")).toBeNull();
    expect(guard.parseVmstat("pswpin 100\n")).toBeNull();
    expect(guard.parseVmstat("lalala 1\n")).toBeNull();
    expect(guard.parseVmstat("pswpin 100\npswpout 200\npgfault 12\n")).toEqual({
      pswpin: 100,
      pswpout: 200,
    });

    // PSI: entrada quebrada -> null.
    expect(guard.parsePsiMemory("")).toBeNull();
    expect(guard.parsePsiMemory("alguma coisa\n")).toBeNull();

    // E o guard continua funcionando (fallback conservador).
    const result = evaluate(
      baseResources({
        swapActivity: { available: false, swapInDelta: null, swapOutDelta: null },
        memoryPressure: { available: false, someAvg10: null, fullAvg10: null },
      }),
    );
    expect(result.safeToBuild).toBe(false);
  });

  it("11) parser de PSI: some/full com avg10, avg60, avg300 e total", () => {
    const parsed = guard.parsePsiMemory(
      [
        "some avg10=1.25 avg60=0.50 avg300=0.10 total=1234",
        "full avg10=0.05 avg60=0.01 avg300=0.00 total=12",
        "",
      ].join("\n"),
    );

    expect(parsed?.someAvg10).toBe(1.25);
    expect(parsed?.fullAvg10).toBe(0.05);
    expect(parsed?.someTotal).toBe(1234);
  });

  it("12) cooldown integrado: swap com atividade -> WAIT, sem atividade -> continua", async () => {
    const states = [
      // 1) swap com atividade de swap -> espera
      { swapActivity: { available: true, swapInDelta: 0, swapOutDelta: 900 } },
      // 2) ainda com atividade -> espera
      { swapActivity: { available: true, swapInDelta: 0, swapOutDelta: 600 } },
      // 3) sem atividade, PSI 0, RAM ok -> continua
      { swapActivity: { available: true, swapInDelta: 0, swapOutDelta: 0 } },
    ];
    let index = 0;
    const readHost = async () => {
      const state = states[Math.min(index, states.length - 1)];
      index += 1;
      return baseResources(state);
    };

    const waits: number[] = [];
    const result = await guard.waitForSafeResources({
      readHost,
      thresholds: THRESHOLDS,
      waitConfig: { intervalSec: 10, timeoutSec: 180 },
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
    // Duas esperas de 10s (o cooldown não virou busy loop).
    expect(waits).toEqual([10_000, 10_000]);
    expect(result.elapsedSec).toBe(20);
  });

  it("13) os thresholds de produção continuam os mesmos (+ os novos)", () => {
    expect(THRESHOLDS.memRequiredMb).toBe(1200);
    expect(THRESHOLDS.swapUsedMaxMb).toBe(512);
    expect(THRESHOLDS.load1Max).toBe(1.5);
    expect(THRESHOLDS.diskFreeMinGb).toBe(2);
    expect(THRESHOLDS.buildHeapMb).toBe(1024);
    // Novos (mínimos, configuráveis por env).
    expect(THRESHOLDS.swapActivityMaxPages).toBe(512);
    expect(THRESHOLDS.psiMemorySomeMax).toBe(1);
    expect(THRESHOLDS.psiMemoryFullMax).toBe(0.01);
    expect(THRESHOLDS.swapActivitySampleMs).toBe(1000);

    const custom = guard.readThresholds({
      KORRELO_ROLLOUT_SWAP_ACTIVITY_MAX_PAGES: "100",
      KORRELO_ROLLOUT_PSI_MEMORY_SOME_MAX: "0.5",
      KORRELO_ROLLOUT_PSI_MEMORY_FULL_MAX: "0",
      KORRELO_ROLLOUT_SWAP_ACTIVITY_SAMPLE_MS: "250",
    });
    expect(custom.swapActivityMaxPages).toBe(100);
    expect(custom.psiMemorySomeMax).toBe(0.5);
    expect(custom.psiMemoryFullMax).toBe(0);
    expect(custom.swapActivitySampleMs).toBe(250);
  });

  it("14) o sleep do cooldown continua com timer REFERENCIADO (sem unref)", () => {
    const source = require("node:fs").readFileSync(
      nodePath.join(
        nodePath.resolve(__dirname, "..", "..", "..", "scripts", "rollout", "lib"),
        "resource-guard.cjs",
      ),
      "utf-8",
    );
    const start = source.indexOf("function defaultSleep");
    const end = source.indexOf("\nfunction ", start + 10);
    const block = source.slice(start, end === -1 ? undefined : end);
    expect(block).toContain("setTimeout(resolve, ms)");
    expect(block).not.toContain("timer.unref");
  });
});

export {};
