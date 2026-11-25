import { MetricsCollectorSchedulerService } from "./metrics-collector-scheduler.service";

/**
 * Scheduler do histórico de métricas.
 *
 * O `collecting` precisa ser liberado em TODOS os caminhos (sucesso, exceção e
 * timeout do watchdog) e o log de "tick ignorado" não pode virar uma linha por
 * minuto para sempre.
 */
describe("MetricsCollectorSchedulerService", () => {
  class FakeRecordMetricSample {
    calls = 0;
    mode: "ok" | "fail" | "hang" = "ok";
    private releaseHang: (() => void) | null = null;

    async execute(): Promise<void> {
      this.calls += 1;
      if (this.mode === "fail") throw new Error("coleta falhou");
      if (this.mode === "hang") {
        return new Promise<void>((resolve) => {
          this.releaseHang = resolve;
        });
      }
      return;
    }

    release(): void {
      this.releaseHang?.();
      this.releaseHang = null;
    }
  }

  class FakeRepository {
    lastCutoff: Date | null = null;
    toDelete = 0;
    async deleteOlderThan(cutoff: Date): Promise<number> {
      this.lastCutoff = cutoff;
      return this.toDelete;
    }
  }

  function makeService(record = new FakeRecordMetricSample(), repository = new FakeRepository()) {
    const service = new MetricsCollectorSchedulerService(record as any, repository as any);
    const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
    const log = jest.spyOn((service as any).logger, "log").mockImplementation(() => undefined);
    return { service, record, repository, warn, log };
  }

  it("libera o sinalizador após uma coleta bem-sucedida", async () => {
    const { service, record } = makeService();

    await service.collect();
    await service.collect();

    expect(record.calls).toBe(2);
    expect((service as any).collecting).toBe(false);
  });

  it("alimenta o histórico de recursos com a MESMA leitura válida", async () => {
    const metrics = { cpuPercent: 5, containers: [] };
    const captured: unknown[] = [];
    const history = {
      capture: async (value: unknown) => {
        captured.push(value);
        return true;
      },
    };
    const service = new MetricsCollectorSchedulerService(
      { execute: async () => metrics } as any,
      new FakeRepository() as any,
      history as any,
    );

    await service.collect();

    expect(captured).toEqual([metrics]);
  });

  it("leitura descartada (null) não vira amostra de recurso", async () => {
    const captured: unknown[] = [];
    const history = {
      capture: async (value: unknown) => {
        captured.push(value);
        return true;
      },
    };
    const service = new MetricsCollectorSchedulerService(
      { execute: async () => null } as any,
      new FakeRepository() as any,
      history as any,
    );

    await service.collect();

    expect(captured).toHaveLength(0);
  });

  it("libera o sinalizador após exceção e a próxima execução acontece", async () => {
    const { service, record, warn } = makeService();
    record.mode = "fail";

    await service.collect();
    expect((service as any).collecting).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);

    record.mode = "ok";
    await service.collect();
    expect(record.calls).toBe(2);
    expect((service as any).collecting).toBe(false);
  });

  it("tick sobreposto é ignorado uma vez por janela, sem log repetitivo", async () => {
    const { service, record, warn } = makeService();
    record.mode = "hang";

    const running = service.collect(); // fica pendurada
    await service.collect(); // tick sobreposto -> ignorado
    await service.collect(); // outro tick -> ignorado, mas sem novo log
    await service.collect();

    expect(record.calls).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/coleta anterior ainda em andamento/);

    // Quando a coleta termina, o sinalizador volta a liberar.
    record.mode = "ok";
    record.release();
    await running;
    expect((service as any).collecting).toBe(false);

    await service.collect();
    expect(record.calls).toBe(2);
  });

  it("a retenção continua independente do coletor", async () => {
    const { service, repository, log } = makeService();
    repository.toDelete = 3;

    const before = Date.now();
    await service.purgeOldSamples();
    const after = Date.now();

    expect(repository.lastCutoff).not.toBeNull();
    const cutoff = repository.lastCutoff as Date;
    // ~7 dias atrás (com folga de 1 minuto para o tempo do teste).
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - sevenDays - 60_000);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - sevenDays + 60_000);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("captura de recursos que nunca termina não bloqueia o scheduler", async () => {
    const metrics = { cpuPercent: 5, containers: [] };
    let release: (() => void) | null = null;
    const history = {
      capture: () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        }),
    };
    const service = new MetricsCollectorSchedulerService(
      { execute: async () => metrics } as any,
      new FakeRepository() as any,
      history as any,
      { collectTimeoutMs: 25 },
    );
    const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);

    await service.collect();

    expect(service.getStatus().collecting).toBe(false);
    expect(service.getStatus().timeouts).toBe(1);
    expect(warn.mock.calls.some(([message]) => /excedeu 25ms/.test(String(message)))).toBe(true);

    // A promise abandonada pode terminar depois; não pode reabrir o lock.
    (release as (() => void) | null)?.();
    await Promise.resolve();
    expect(service.getStatus().collecting).toBe(false);
  });

  it("coleta que excede o intervalo é abandonada e o próximo tick roda", async () => {
    const record = new FakeRecordMetricSample();
    const fast = new MetricsCollectorSchedulerService(
      record as any,
      new FakeRepository() as any,
      undefined,
      { collectTimeoutMs: 20 },
    );
    const warn = jest.spyOn((fast as any).logger, "warn").mockImplementation(() => undefined);
    const success = jest.spyOn((fast as any).logger, "log").mockImplementation(() => undefined);

    record.mode = "hang";
    await fast.collect();
    expect(fast.getStatus().collecting).toBe(false);
    expect(fast.getStatus().timeouts).toBe(1);
    expect(warn).toHaveBeenCalled();

    record.mode = "ok";
    await fast.collect();
    expect(record.calls).toBe(2);
    expect(fast.getStatus().collecting).toBe(false);
    expect(success.mock.calls.some(([message]) => /recuperada/.test(String(message)))).toBe(true);
  });

  it("métrica stale nunca vira amostra de recurso", async () => {
    const captured: unknown[] = [];
    const service = new MetricsCollectorSchedulerService(
      { execute: async () => ({ cpuPercent: 5, stale: true, containers: [] }) } as any,
      new FakeRepository() as any,
      {
        capture: async (value: unknown) => {
          captured.push(value);
          return true;
        },
      } as any,
    );

    await service.collect();

    expect(captured).toHaveLength(0);
    expect(service.getStatus().collecting).toBe(false);
  });

  it("erro da captura de recursos não deixa o lock preso", async () => {
    const service = new MetricsCollectorSchedulerService(
      { execute: async () => ({ cpuPercent: 5, containers: [] }) } as any,
      new FakeRepository() as any,
      {
        capture: async () => {
          throw new Error("disco cheio");
        },
      } as any,
    );
    const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);

    await service.collect();

    expect(service.getStatus().collecting).toBe(false);
    expect(warn.mock.calls.some(([message]) => /disco cheio/.test(String(message)))).toBe(true);
  });

  it("primeira amostra de CPU (null) é ignorada; a seguinte alimenta o histórico", async () => {
    const captured: unknown[] = [];
    let calls = 0;
    const service = new MetricsCollectorSchedulerService(
      {
        execute: async () => {
          calls += 1;
          return calls === 1 ? null : { cpuPercent: 7, containers: [] };
        },
      } as any,
      new FakeRepository() as any,
      {
        capture: async (value: unknown) => {
          captured.push(value);
          return true;
        },
      } as any,
    );

    await service.collect();
    expect(captured).toHaveLength(0);
    await service.collect();
    expect(captured).toHaveLength(1);
  });
});
