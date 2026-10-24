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
});
