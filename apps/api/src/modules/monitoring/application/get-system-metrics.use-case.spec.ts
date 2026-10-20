import type { SystemMetrics } from "@korrelo/shared-types";

/**
 * Testes do cache/circuit breaker das métricas.
 *
 * Cenário que motivou o código: no incidente de 19/10/2026 o `docker stats`
 * ficou pendurado, a promise "in-flight" nunca resolveu e o dashboard inteiro
 * travou atrás dela. Aqui garantimos que:
 * - uma coleta em andamento é compartilhada (nada de um `docker stats` por
 *   requisição);
 * - a promise é sempre liberada;
 * - falha vira cache "desatualizado" + backoff, nunca um 0% falso;
 * - o sistema se recupera sozinho quando o Docker volta.
 */

function buildMetrics(overrides: Partial<SystemMetrics> = {}): SystemMetrics {
  return {
    cpuPercent: 21,
    totalMemMb: 4096,
    freeMemMb: 2048,
    usedMemPercent: 50,
    diskTotalGb: 40,
    diskFreeGb: 20,
    usedDiskPercent: 50,
    uptimeSeconds: 1000,
    tier: "micro",
    containers: [{ name: "app", status: "Up", memUsageMb: 100, memLimitMb: 512, cpuPercent: 2 }],
    ...overrides,
  };
}

type CollectorBehavior = "ok" | "throws" | "dockerDown";

class FakeCollector {
  calls = 0;
  behavior: CollectorBehavior = "ok";

  async collect(): Promise<SystemMetrics> {
    this.calls += 1;
    if (this.behavior === "throws") {
      throw new Error("docker travado");
    }
    if (this.behavior === "dockerDown") {
      return buildMetrics({ dockerReachable: false, containers: [] });
    }
    return buildMetrics();
  }
}

const ENV_KEYS = [
  "SYSTEM_METRICS_CACHE_TTL_MS",
  "SYSTEM_METRICS_FAILURE_THRESHOLD",
  "SYSTEM_METRICS_BACKOFF_BASE_MS",
  "SYSTEM_METRICS_BACKOFF_MAX_MS",
];

function loadUseCase(env: Record<string, string>) {
  jest.resetModules();
  const previous: Record<string, string | undefined> = {};
  for (const key of [...ENV_KEYS, ...Object.keys(env)]) {
    previous[key] = process.env[key];
  }
  Object.assign(process.env, env);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { GetSystemMetricsUseCase } = require("./get-system-metrics.use-case");

  return {
    GetSystemMetricsUseCase,
    restore: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("GetSystemMetricsUseCase", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("devolve as métricas coletadas e reutiliza o cache", async () => {
    const { GetSystemMetricsUseCase, restore } = loadUseCase({ SYSTEM_METRICS_CACHE_TTL_MS: "2000" });
    const collector = new FakeCollector();
    const useCase = new GetSystemMetricsUseCase(collector);

    const first = await useCase.execute();
    const second = await useCase.execute();

    expect(first.cpuPercent).toBe(21);
    expect(second).toBe(first);
    expect(collector.calls).toBe(1);
    restore();
  });

  it("compartilha UMA coleta entre requisições simultâneas", async () => {
    const { GetSystemMetricsUseCase, restore } = loadUseCase({ SYSTEM_METRICS_CACHE_TTL_MS: "1" });
    const collector = new FakeCollector();
    const useCase = new GetSystemMetricsUseCase(collector);

    const [a, b, c] = await Promise.all([useCase.execute(), useCase.execute(), useCase.execute()]);

    expect(collector.calls).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    restore();
  });

  it("quando a coleta falha, devolve o último valor conhecido marcado como desatualizado", async () => {
    const { GetSystemMetricsUseCase, restore } = loadUseCase({ SYSTEM_METRICS_CACHE_TTL_MS: "1" });
    const collector = new FakeCollector();
    const useCase = new GetSystemMetricsUseCase(collector);

    const fresh = await useCase.execute();
    await sleep(10);
    collector.behavior = "throws";

    const stale = await useCase.execute();

    expect(stale.stale).toBe(true);
    expect(stale.cpuPercent).toBe(fresh.cpuPercent);
    expect(stale.dockerReachable).toBe(false);
    restore();
  });

  it("abre o circuito após falhas consecutivas e para de chamar o Docker", async () => {
    const { GetSystemMetricsUseCase, restore } = loadUseCase({
      SYSTEM_METRICS_CACHE_TTL_MS: "1",
      SYSTEM_METRICS_FAILURE_THRESHOLD: "2",
      // Janela de backoff de 200ms (e não 20ms): o teste dorme 5ms antes da
      // terceira chamada, e sob carga esse sleep passava da janela de 20ms -
      // o circuito deixava passar uma chamada e o teste falhava de forma
      // intermitente (flakiness que já derrubou o CI).
      SYSTEM_METRICS_BACKOFF_BASE_MS: "200",
      SYSTEM_METRICS_BACKOFF_MAX_MS: "200",
    });
    const collector = new FakeCollector();
    collector.behavior = "throws";
    const useCase = new GetSystemMetricsUseCase(collector);

    await useCase.execute();
    expect(collector.calls).toBe(1);

    // Espera o backoff expirar: a segunda tentativa acontece e falha de novo.
    await sleep(260);
    await useCase.execute();
    expect(collector.calls).toBe(2);
    expect(useCase.getStatus().consecutiveFailures).toBe(2);
    expect(useCase.getStatus().circuitOpen).toBe(true);

    // Dentro da janela de backoff: nenhuma nova tentativa de falar com o Docker.
    const callsAfterFailures = collector.calls;
    await sleep(5);
    const duringBackoff = await useCase.execute();

    expect(collector.calls).toBe(callsAfterFailures);
    expect(duringBackoff.stale).toBe(true);
    restore();
  });

  it("recupera automaticamente quando o Docker volta a responder", async () => {
    const { GetSystemMetricsUseCase, restore } = loadUseCase({
      SYSTEM_METRICS_CACHE_TTL_MS: "1",
      SYSTEM_METRICS_FAILURE_THRESHOLD: "1",
      SYSTEM_METRICS_BACKOFF_BASE_MS: "10",
      SYSTEM_METRICS_BACKOFF_MAX_MS: "10",
    });
    const collector = new FakeCollector();
    collector.behavior = "throws";
    const useCase = new GetSystemMetricsUseCase(collector);

    await useCase.execute();
    expect(useCase.getStatus().consecutiveFailures).toBe(1);

    await sleep(20);
    collector.behavior = "ok";
    const recovered = await useCase.execute();

    expect(recovered.stale).toBeUndefined();
    expect(recovered.cpuPercent).toBe(21);
    expect(useCase.getStatus().consecutiveFailures).toBe(0);
    expect(useCase.getStatus().circuitOpen).toBe(false);
    restore();
  });

  it("sem nenhum valor anterior, devolve 'indisponível' em vez de zeros silenciosos", async () => {
    const { GetSystemMetricsUseCase, restore } = loadUseCase({ SYSTEM_METRICS_CACHE_TTL_MS: "1" });
    const collector = new FakeCollector();
    collector.behavior = "throws";
    const useCase = new GetSystemMetricsUseCase(collector);

    const metrics = await useCase.execute();

    expect(metrics.available).toBe(false);
    expect(metrics.stale).toBe(true);
    expect(metrics.dockerReachable).toBe(false);
    expect(metrics.containers).toEqual([]);
    restore();
  });

  it("trata Docker que não responde como falha (sem devolver lista vazia como se fosse normal)", async () => {
    const { GetSystemMetricsUseCase, restore } = loadUseCase({ SYSTEM_METRICS_CACHE_TTL_MS: "1" });
    const collector = new FakeCollector();
    collector.behavior = "dockerDown";
    const useCase = new GetSystemMetricsUseCase(collector);

    const metrics = await useCase.execute();

    expect(metrics.dockerReachable).toBe(false);
    expect(metrics.stale).toBe(true);
    expect(useCase.getStatus().consecutiveFailures).toBe(1);
    restore();
  });
});
