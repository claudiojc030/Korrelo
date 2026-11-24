import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SystemMetrics } from "@korrelo/shared-types";
import { safeHostResourceProvider } from "../../../infrastructure/host-resources";
import { ResourceHistoryService } from "./resource-history.service";

/**
 * FASE A — captura e persistência.
 *
 * A captura reutiliza as métricas já coletadas pelo scheduler; o serviço não
 * pode derrubar o Core nem gravar leitura stale. O histórico sobrevive a
 * restart via arquivo JSON pequeno.
 */
function metrics(overrides: Partial<SystemMetrics> = {}): SystemMetrics {
  return {
    cpuPercent: 12,
    totalMemMb: 4096,
    freeMemMb: 2370,
    usedMemPercent: 42,
    diskTotalGb: 80,
    diskFreeGb: 40,
    usedDiskPercent: 50,
    uptimeSeconds: 1000,
    tier: "small",
    containers: [
      {
        name: "/mesatta",
        status: "running",
        memUsageMb: 386,
        memLimitMb: 1757,
        cpuPercent: 2,
      },
    ],
    ...overrides,
  };
}

describe("ResourceHistoryService", () => {
  const dirs: string[] = [];

  function tempFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "korrelo-resource-history-"));
    dirs.push(dir);
    return join(dir, "resource-history.json");
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    delete process.env.KORRELO_RESOURCE_HISTORY_ENABLED;
  });

  it("captura memória do container, host e pressão no MESMO tick", async () => {
    const service = new ResourceHistoryService({
      provider: safeHostResourceProvider({
        memAvailableMb: 2370,
        swapUsedMb: 723,
        swapActivity: { available: true, swapInDelta: 0, swapOutDelta: 0 },
        memoryPressure: { available: true, someAvg10: 0, fullAvg10: 0 },
      }),
      filePath: tempFile(),
      persistIntervalMs: 0,
    });

    const captured = await service.capture(metrics());

    expect(captured).toBe(true);
    const summary = service.summary("mesatta");
    expect(summary?.container).toMatchObject({
      currentMb: 386,
      peakMb: 386,
      limitMb: 1757,
    });
    expect(summary?.host.minMemAvailableMb).toBe(2370);
  });

  it("não grava leitura stale/indisponível (política conservadora continua)", async () => {
    const service = new ResourceHistoryService({
      provider: safeHostResourceProvider(),
      filePath: tempFile(),
    });

    expect(await service.capture(metrics({ stale: true }))).toBe(false);
    expect(await service.capture(metrics({ available: false }))).toBe(false);
    expect(service.summary("mesatta")?.container).toBeNull();
  });

  it("falha do coletor não lança e não grava amostra", async () => {
    const provider = safeHostResourceProvider();
    provider.getMemInfo = async () => {
      throw new Error("sem /proc");
    };
    const service = new ResourceHistoryService({ provider, filePath: tempFile() });

    await expect(service.capture(metrics())).resolves.toBe(false);
    expect(service.summary("mesatta")?.container).toBeNull();
  });

  it("persiste e recarrega após restart", async () => {
    const filePath = tempFile();
    const provider = safeHostResourceProvider({ memAvailableMb: 2300 });
    const first = new ResourceHistoryService({ provider, filePath, persistIntervalMs: 0 });

    await first.capture(metrics());
    first.onApplicationShutdown();

    const second = new ResourceHistoryService({ provider, filePath });
    second.onModuleInit();

    const summary = second.summary("mesatta");
    expect(summary?.samples).toBe(1);
    expect(summary?.container?.peakMb).toBe(386);
    expect(second.describe("mesatta").confidence).toBe("low");
  });

  it("grava de forma atômica e com permissão restrita no POSIX", async () => {
    const filePath = tempFile();
    const service = new ResourceHistoryService({
      provider: safeHostResourceProvider(),
      filePath,
      persistIntervalMs: 0,
    });

    await service.capture(metrics());
    service.onApplicationShutdown();

    // O temporário não sobrevive ao rename atômico.
    expect(() => statSync(`${filePath}.tmp`)).toThrow();

    if (process.platform !== "win32") {
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  it("arquivo corrompido não impede o Core de subir e é substituído na próxima escrita", async () => {
    const filePath = tempFile();
    writeFileSync(filePath, "{ isso não é json", "utf8");
    const service = new ResourceHistoryService({
      provider: safeHostResourceProvider(),
      filePath,
      persistIntervalMs: 0,
    });

    expect(() => service.onModuleInit()).not.toThrow();
    expect(service.summary("mesatta")?.container).toBeNull();

    await service.capture(metrics());
    expect(service.summary("mesatta")?.container?.peakMb).toBe(386);
  });

  it("pode ser desligado por ambiente sem afetar o Core", async () => {
    process.env.KORRELO_RESOURCE_HISTORY_ENABLED = "0";
    const service = new ResourceHistoryService({
      provider: safeHostResourceProvider(),
      filePath: tempFile(),
    });

    expect(await service.capture(metrics())).toBe(false);
    expect(service.summary("mesatta")?.container).toBeNull();
  });
});
