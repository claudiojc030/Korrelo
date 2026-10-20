import * as os from "node:os";
import { runCommand } from "../../../infrastructure/command-runner";
import { ResourcePreflightService } from "./resource-preflight.service";
import { safeHostResourceProvider } from "../../../infrastructure/host-resources";

jest.mock("node:os", () => {
  const actual = jest.requireActual("node:os");
  return {
    ...actual,
    totalmem: jest.fn(() => 4 * 1024 * 1024 * 1024),
    freemem: jest.fn(() => 2 * 1024 * 1024 * 1024),
    // O load do host é mockado: o teste NUNCA pode depender do load real da
    // máquina que roda o Jest (no CI o runner chegou a load1 = 3.25 e
    // interceptou os testes de memória/disco/Docker).
    loadavg: jest.fn(() => [0.1, 0.1, 0.1]),
  };
});

jest.mock("../../../infrastructure/command-runner", () => ({
  runCommand: jest.fn(),
}));

const mockedRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;
const mockedOs = os as unknown as { totalmem: jest.Mock; freemem: jest.Mock; loadavg: jest.Mock };

type CommandResult = Awaited<ReturnType<typeof runCommand>>;

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
    durationMs: 3,
    ...overrides,
  };
}

/**
 * Os testes do preflight NUNCA podem depender dos recursos reais da máquina
 * que roda o Jest.
 *
 * No CI isso quebrou: o runner do GitHub estava com load1 = 3.25 (limite
 * 1.5) e a regra de load interceptava os testes de memória, disco e Docker
 * ANTES deles exertarem o que deveriam validar.
 *
 * Aqui o provider de métricas do host é SEMPRE injetado com valores
 * seguros (MemAvailable ok, load 0.1, swap activity 0, PSI 0, disco ok) e
 * cada teste sobrescreve APENENTE o sinal que ele quer exercitar.
 */
describe("ResourcePreflightService", () => {
  function makeService(overrides: Parameters<typeof safeHostResourceProvider>[0] = {}) {
    return new ResourcePreflightService(safeHostResourceProvider(overrides));
  }

  beforeEach(() => {
    mockedRunCommand.mockReset();
    mockedOs.totalmem.mockReturnValue(4 * 1024 * 1024 * 1024);
    mockedOs.freemem.mockReturnValue(2 * 1024 * 1024 * 1024);
    mockedOs.loadavg.mockReturnValue([0.1, 0.1, 0.1]);
    mockedRunCommand.mockImplementation(async (command: string) => {
      if (command === "df") {
        // 48 GB de disco, 24 GB livres
        return result({ stdout: "Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 50000000 25000000 25000000 50% /\n" });
      }
      return result({ stdout: "app\n" });
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("libera o build quando há memória, disco e Docker disponíveis", async () => {
    const service = makeService();
    const check = await service.check({ requiredMemoryMb: 1024, requiredDiskMb: 2000 });

    expect(check.ok).toBe(true);
    expect(check.reason).toBeNull();
    expect(check.metrics.totalMemMb).toBe(4096);
    // A memória livre vem do PROVIDER injetado (4096 MB), não do os.freemem()
    // real da máquina (2048 MB no mock) nem do /proc/meminfo real.
    expect(check.metrics.freeMemMb).toBe(4096);
    // Nenhum sinal do host bloqueou (a avaliação do host é SAFE).
    if (check.host) {
      expect(check.host.safe).toBe(true);
      expect(check.host.checks.every((c) => c.ok)).toBe(true);
    }
  });

  it("BLOQUEIA o build quando não há memória livre suficiente", async () => {
    // Só o sinal de memória muda: load, swap, PSI e disco seguem seguros.
    const service = makeService({ memAvailableMb: 300 });
    const check = await service.check({ requiredMemoryMb: 1024, requiredDiskMb: 2000 });

    expect(check.ok).toBe(false);
    // O sinal responsável é a MEMÓRIA (e não o load da máquina do CI).
    expect(check.reason).toContain("memória disponível");
    expect(check.reason).toContain("300 MB");
    // Isolamento: o bloqueio NÃO veio de load/swap/PSI.
    expect(check.reason).not.toContain("load average");
    expect(check.reason).not.toContain("swap em uso");
  });

  it("BLOQUEIA o build quando o disco está criticamente baixo", async () => {
    mockedRunCommand.mockImplementation(async (command: string) => {
      if (command === "df") {
        // 500 MB livres
        return result({ stdout: "Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 1000000 999500 500 99% /\n" });
      }
      return result();
    });

    const service = makeService();
    const check = await service.check({ requiredMemoryMb: 1024, requiredDiskMb: 2000 });

    expect(check.ok).toBe(false);
    expect(check.reason).toContain("disco livre insuficiente");
    // Isolamento: o bloqueio NÃO veio de load/swap/PSI.
    expect(check.reason).not.toContain("load average");
    expect(check.reason).not.toContain("swap em uso");
  });

  it("BLOQUEIA o build quando o Docker não responde", async () => {
    mockedRunCommand.mockImplementation(async (command: string) => {
      if (command === "docker") return result({ timedOut: true, exitCode: null });
      return result();
    });

    const service = makeService();
    const check = await service.check({ requiredMemoryMb: 1024, requiredDiskMb: 2000 });

    expect(check.ok).toBe(false);
    expect(check.reason).toContain("Docker");
  });

  it("BLOQUEIA quando já existe um build em andamento", async () => {
    const service = makeService();
    const check = await service.check({ activeBuilds: 1 });

    expect(check.ok).toBe(false);
    expect(check.reason).toContain("build(s) em andamento");
  });

  it("BLOQUEIA quando o load do host está alto (sinal isolado)", async () => {
    const service = makeService({ load1: 3.25 });
    const check = await service.check({ requiredMemoryMb: 1024, requiredDiskMb: 2000 });

    expect(check.ok).toBe(false);
    expect(check.reason).toContain("load average");
    expect(check.reason).toContain("3.25");
    // Isolamento: o bloqueio NÃO veio de memória/swap/PSI.
    expect(check.reason).not.toContain("memória disponível");
    expect(check.reason).not.toContain("swap em uso");
  });

  it("BLOQUEIA quando há atividade real de swap (sinal isolado)", async () => {
    const service = makeService({
      swapUsedMb: 900,
      swapActivity: { available: true, swapInDelta: 0, swapOutDelta: 900 },
    });
    const check = await service.check({ requiredMemoryMb: 1024, requiredDiskMb: 2000 });

    expect(check.ok).toBe(false);
    expect(check.reason).toContain("swap em uso");
  });

  it("BLOQUEIA quando o PSI de memória está alto (sinal isolado)", async () => {
    const service = makeService({
      memoryPressure: { available: true, someAvg10: 4.2, fullAvg10: 0.2 },
    });
    const check = await service.check({ requiredMemoryMb: 1024, requiredDiskMb: 2000 });

    expect(check.ok).toBe(false);
    // O sinal de PSI aparece dentro do detalhe do swap (nome do check:
    // "swap em uso" com a pressão real medida).
    expect(check.reason).toMatch(/PSI some=4\.2/);
    expect(check.reason).toContain("swap em uso");
  });

  // ------------------------------------------------------- regressão do CI
  describe("regressão do CI: o host real não decide o teste", () => {
    it("o provider INJETADO manda: load real alto NÃO bloqueia os testes", async () => {
      // Exatamente o que quebrou no GitHub Actions: o runner estava com
      // load1 = 3.25 (limite 1.5) e a regra de load interceptava os testes
      // de memória/disco/Docker ANTES deles exertarem o sinal que queriam.
      mockedOs.loadavg.mockReturnValue([3.25, 3.1, 2.9]);
      const service = makeService();
      const check = await service.check({ requiredMemoryMb: 1024, requiredDiskMb: 2000 });

      // O load REAL da máquina é irrelevante: o provider injetado (0.1) vale.
      expect(check.ok).toBe(true);
      expect(check.reason).toBeNull();
    });

    it("o provider INJETADO com load alto bloqueia (o valor do teste manda)", async () => {
      mockedOs.loadavg.mockReturnValue([0.1, 0.1, 0.1]);
      const service = makeService({ load1: 3.25 });
      const check = await service.check({ requiredMemoryMb: 1024, requiredDiskMb: 2000 });

      expect(check.ok).toBe(false);
      expect(check.reason).toContain("load average");
    });
  });

  it("PERMITE o build com swap histórica (sem atividade e sem PSI)", async () => {
    // O caso real da VPS: 601 MB de swap, mas nada trocando memória agora.
    const service = makeService({
      memAvailableMb: 2648,
      swapUsedMb: 601,
      swapTotalMb: 2047,
      load1: 0.13,
      swapActivity: { available: true, swapInDelta: 0, swapOutDelta: 0 },
      memoryPressure: { available: true, someAvg10: 0, fullAvg10: 0 },
    });
    const check = await service.check({ requiredMemoryMb: 1024, requiredDiskMb: 2000 });

    expect(check.ok).toBe(true);
    expect(check.reason).toBeNull();
  });
});
