/**
 * AMOSTRAGEM DE CPU (por delta de /proc/stat).
 *
 * O bug real: o cálculo antigo (os.cpus() com janela de 300 ms) dava
 * 67%/76%/100% num host de 1 vCPU com load 0.01 e vmstat idle 90%+.
 * Com granularidade de 10 ms por tick, 300 ms = ~30 ticks: bastava ~30 ms
 * de atividade para o `idle` não registrar NENHUM tick -> idleDelta = 0
 * -> 100% de CPU num host ocioso.
 *
 * Aqui provamos o comportamento do cálculo por delta.
 */

import {
  computeCpuPercent,
  CpuUsageSampler,
  parseProcStatCpuTimes,
  sumOsCpuTimes,
  type CpuTimes,
} from "./cpu-usage-sampler";

/** /proc/stat com a linha agregada "cpu ". */
function procStat(user: number, nice: number, system: number, idle: number, iowait = 0): string {
  return [
    `cpu  ${user} ${nice} ${system} ${idle} ${iowait} 0 0 0`,
    "cpu0 1 2 3 4 5 6 7 8",
    "intr 12345",
    "ctxt 6789",
    "btime 1700000000",
    "processes 4242",
    "procs_running 1",
    "procs_blocked 0",
  ].join("\n");
}

describe("cpu-usage-sampler - leitura do /proc/stat", () => {
  it("lê a linha agregada e soma todos os tempos", () => {
    const times = parseProcStatCpuTimes(procStat(100, 10, 50, 800, 40));

    expect(times).not.toBeNull();
    // total = user+nice+system+idle+iowait = 100+10+50+800+40
    expect(times?.total).toBe(1000);
    // idle = idle + iowait (o host não estava computando)
    expect(times?.idle).toBe(840);
  });

  it("linha corrompida devolve null (não inventa número)", () => {
    expect(parseProcStatCpuTimes("")).toBeNull();
    expect(parseProcStatCpuTimes("lixo\n")).toBeNull();
    expect(parseProcStatCpuTimes("cpu  1 2 x 4\n")).toBeNull();
    expect(parseProcStatCpuTimes("cpu  1 2\n")).toBeNull();
    expect(parseProcStatCpuTimes("cpu  1 -2 3 4\n")).toBeNull();
  });

  it("sem /proc/stat, o fallback (os.cpus()) devolve contadores", () => {
    const times = sumOsCpuTimes();
    // Só importa que é um par válido (o ambiente de teste tem CPUs).
    if (times) {
      expect(times.total).toBeGreaterThan(0);
      expect(times.idle).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("cpu-usage-sampler - percentual por delta", () => {
  const base: CpuTimes = { total: 1000, idle: 900 };

  it("0% quando o host ficou 100% ocioso", () => {
    const current: CpuTimes = { total: 2000, idle: 1900 };
    expect(computeCpuPercent(base, current)).toBe(0);
  });

  it("~10% de uso", () => {
    // 100 ticks de total, 10 ticks de CPU, 90 de idle.
    const current: CpuTimes = { total: 1100, idle: 990 };
    expect(computeCpuPercent(base, current)).toBe(10);
  });

  it("~50% de uso", () => {
    const current: CpuTimes = { total: 1100, idle: 950 };
    expect(computeCpuPercent(base, current)).toBe(50);
  });

  it("100% de uso (nenhum tick de idle)", () => {
    const current: CpuTimes = { total: 1100, idle: 900 };
    expect(computeCpuPercent(base, current)).toBe(100);
  });

  it("delta zero devolve null (NUNCA 100% por falta de informação)", () => {
    expect(computeCpuPercent(base, { total: 1000, idle: 900 })).toBeNull();
  });

  it("contador reiniciado (total menor) devolve null", () => {
    expect(computeCpuPercent(base, { total: 10, idle: 5 })).toBeNull();
  });

  it("idle que andou para trás devolve null", () => {
    expect(computeCpuPercent(base, { total: 1100, idle: 800 })).toBeNull();
  });

  it("idle maior que o total devolve null (leitura inválida)", () => {
    expect(computeCpuPercent(base, { total: 1100, idle: 1200 })).toBeNull();
  });

  it("sem amostra anterior devolve null (primeira amostra)", () => {
    expect(computeCpuPercent(null, base)).toBeNull();
    expect(computeCpuPercent(base, null)).toBeNull();
  });

  it("o resultado é clampado em 0..100", () => {
    // 100% ocioso -> 0% (válido: o host não fez nada).
    // totalDelta = 100, idleDelta = 100 -> 0%.
    expect(computeCpuPercent(base, { total: 1100, idle: 1000 })).toBe(0);
    // Nenhum tick de idle -> 100% (teto).
    expect(computeCpuPercent(base, { total: 1100, idle: 900 })).toBe(100);
    // Um idle "negativo" (leitura inválida) nunca vira número: null.
    expect(computeCpuPercent(base, { total: 1100, idle: -50 })).toBeNull();
  });
});

describe("cpu-usage-sampler - amostras", () => {
  it("a PRIMEIRA amostra devolve null (não mostra 100%)", () => {
    const sampler = new CpuUsageSampler(() => procStat(100, 10, 50, 800, 40));

    const first = sampler.sample();

    expect(first.percent).toBeNull();
    expect(first.source).toBe("proc-stat");
    expect(first.sampledAt).toBeDefined();
  });

  it("a segunda amostra usa o DELTA contra a primeira", () => {
    let leitura = procStat(100, 10, 50, 800, 40);
    const sampler = new CpuUsageSampler(() => leitura);

    expect(sampler.sample().percent).toBeNull();

    // +100 ticks de total, +90 de idle -> 10 ticks de CPU -> 10%.
    leitura = procStat(160, 10, 0, 890, 40);
    const second = sampler.sample();

    expect(second.percent).toBe(10);
    expect(second.source).toBe("proc-stat");
  });

  it("contador reiniciado devolve null (e não 100%)", () => {
    let leitura = procStat(1000, 0, 0, 9000, 0);
    const sampler = new CpuUsageSampler(() => leitura);

    sampler.sample();
    leitura = procStat(10, 0, 0, 5, 0); // host reiniciou
    const afterReset = sampler.sample();

    expect(afterReset.percent).toBeNull();
  });

  it("sem /proc/stat, usa o fallback (mesmo esquema de 2 amostras)", () => {
    let cpus = { total: 1000, idle: 900 };
    const sampler = new CpuUsageSampler(
      () => null,
      () => cpus,
    );

    const first = sampler.sample();
    expect(first.percent).toBeNull();
    expect(first.source).toBe("fallback");

    cpus = { total: 1100, idle: 990 };
    const second = sampler.sample();
    expect(second.source).toBe("fallback");
    expect(second.percent).toBe(10);
  });

  it("com /proc/stat indisponível E os.cpus() indisponível, devolve null", () => {
    const sampler = new CpuUsageSampler(
      () => null,
      () => null,
    );

    const sample = sampler.sample();

    expect(sample.percent).toBeNull();
    expect(sample.source).toBe("fallback");
  });

  it("a leitura do /proc/stat é sempre a PRIMEIRA amostra (source coerente)", () => {
    // Se o /proc/stat volta a aparecer, a medição volta a ser "proc-stat".
    let disponivel = true;
    const sampler = new CpuUsageSampler(() => (disponivel ? procStat(100, 0, 0, 900) : null));

    expect(sampler.sample().source).toBe("proc-stat");
    disponivel = false;
    const fallback = sampler.sample();
    expect(fallback.source).toBe("fallback");
    // Sem a amostra anterior de /proc/stat, o fallback não tem delta: null.
    expect(fallback.percent).toBeNull();
  });
});
