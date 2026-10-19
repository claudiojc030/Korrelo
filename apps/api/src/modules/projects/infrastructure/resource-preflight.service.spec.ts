import * as os from "node:os";
import { runCommand } from "../../../infrastructure/command-runner";
import { ResourcePreflightService } from "./resource-preflight.service";

jest.mock("node:os", () => {
  const actual = jest.requireActual("node:os");
  return {
    ...actual,
    totalmem: jest.fn(() => 4 * 1024 * 1024 * 1024),
    freemem: jest.fn(() => 2 * 1024 * 1024 * 1024),
  };
});

jest.mock("../../../infrastructure/command-runner", () => ({
  runCommand: jest.fn(),
}));

const mockedRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;
const mockedOs = os as unknown as { totalmem: jest.Mock; freemem: jest.Mock };

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

describe("ResourcePreflightService", () => {
  const service = new ResourcePreflightService();

  beforeEach(() => {
    mockedRunCommand.mockReset();
    mockedOs.totalmem.mockReturnValue(4 * 1024 * 1024 * 1024);
    mockedOs.freemem.mockReturnValue(2 * 1024 * 1024 * 1024);
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
    const check = await service.check({ requiredMemoryMb: 1024, requiredDiskMb: 2000 });

    expect(check.ok).toBe(true);
    expect(check.reason).toBeNull();
    expect(check.metrics.totalMemMb).toBe(4096);
    expect(check.metrics.freeMemMb).toBe(2048);
  });

  it("BLOQUEIA o build quando não há memória livre suficiente", async () => {
    mockedOs.freemem.mockReturnValue(300 * 1024 * 1024);

    const check = await service.check({ requiredMemoryMb: 1024, requiredDiskMb: 2000 });

    expect(check.ok).toBe(false);
    expect(check.reason).toContain("memória livre insuficiente");
  });

  it("BLOQUEIA o build quando o disco está criticamente baixo", async () => {
    mockedRunCommand.mockImplementation(async (command: string) => {
      if (command === "df") {
        // 500 MB livres
        return result({ stdout: "Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 1000000 999500 500 99% /\n" });
      }
      return result();
    });

    const check = await service.check({ requiredMemoryMb: 1024, requiredDiskMb: 2000 });

    expect(check.ok).toBe(false);
    expect(check.reason).toContain("disco livre insuficiente");
  });

  it("BLOQUEIA o build quando o Docker não responde", async () => {
    mockedRunCommand.mockImplementation(async (command: string) => {
      if (command === "docker") return result({ timedOut: true, exitCode: null });
      return result();
    });

    const check = await service.check({ requiredMemoryMb: 1024, requiredDiskMb: 2000 });

    expect(check.ok).toBe(false);
    expect(check.reason).toContain("Docker");
  });

  it("BLOQUEIA quando já existe um build em andamento", async () => {
    const check = await service.check({ activeBuilds: 1 });

    expect(check.ok).toBe(false);
    expect(check.reason).toContain("build(s) em andamento");
  });
});
