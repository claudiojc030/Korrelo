import { Logger } from "@nestjs/common";
import { runCommand } from "../../../infrastructure/command-runner";
import { OsSystemMetricsCollector } from "./os-system-metrics-collector";

jest.mock("../../../infrastructure/command-runner", () => ({
  runCommand: jest.fn(),
}));

const mockedRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;

type CommandResult = Awaited<ReturnType<typeof runCommand>>;

/** O comando de disco muda conforme o SO (df no Linux, powershell no Windows). */
const DISK_COMMAND = process.platform === "win32" ? "powershell" : "df";

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
    durationMs: 5,
    ...overrides,
  };
}

function diskOk(): CommandResult {
  return process.platform === "win32"
    ? result({ stdout: JSON.stringify({ Used: 500_000_000, Free: 500_000_000 }) })
    : result({ stdout: "Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 1000000 500000 500000 50% /\n" });
}

/** Resposta padrão: Docker respondendo normalmente. */
function withHealthyDocker(): void {
  mockedRunCommand.mockImplementation(async (command: string, args: string[]) => {
    if (command === "docker" && args[0] === "ps") {
      return result({ stdout: "korrelo-app-1|Up 2 hours\nkorrelo-db-1|Up 2 hours\n" });
    }
    if (command === "docker" && args[0] === "stats") {
      return result({ stdout: "korrelo-app-1|120.5MiB / 512MiB|3.5%\nkorrelo-db-1|50MiB / 256MiB|1.0%\n" });
    }
    if (command === DISK_COMMAND) {
      return diskOk();
    }
    return result();
  });
}

describe("OsSystemMetricsCollector", () => {
  beforeEach(() => {
    mockedRunCommand.mockReset();
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("lê containers e disco quando o Docker responde", async () => {
    withHealthyDocker();
    const collector = new OsSystemMetricsCollector();

    const metrics = await collector.collect();

    expect(metrics.dockerReachable).toBe(true);
    expect(metrics.containers).toHaveLength(2);
    expect(metrics.containers[0].name).toBe("korrelo-app-1");
    expect(metrics.containers[0].memUsageMb).toBe(121);
    expect(metrics.containers[0].memLimitMb).toBe(512);
    expect(metrics.containers[0].cpuPercent).toBe(3.5);
    expect(metrics.diskTotalGb).not.toBeNull();
    expect(metrics.collectedAt).toBeDefined();
  });

  it("não trava e sinaliza o Docker indisponível quando o comando estoura o timeout", async () => {
    mockedRunCommand.mockImplementation(async (command: string, args: string[]) => {
      if (command === "docker" && args[0] === "ps") {
        return result({ timedOut: true, exitCode: null, signal: "SIGTERM" });
      }
      return result();
    });
    const collector = new OsSystemMetricsCollector();

    const metrics = await collector.collect();

    expect(metrics.dockerReachable).toBe(false);
    expect(metrics.containers).toEqual([]);
  });

  it("não trava quando o binário do Docker nem existe", async () => {
    mockedRunCommand.mockImplementation(async (command: string) => {
      if (command === "docker") {
        throw new Error("spawn docker ENOENT");
      }
      return result();
    });
    const collector = new OsSystemMetricsCollector();

    const metrics = await collector.collect();

    expect(metrics.dockerReachable).toBe(false);
    expect(metrics.containers).toEqual([]);
  });

  it("mantém a lista de containers quando só o 'docker stats' falha", async () => {
    mockedRunCommand.mockImplementation(async (command: string, args: string[]) => {
      if (command === "docker" && args[0] === "ps") {
        return result({ stdout: "korrelo-app-1|Up 2 hours\n" });
      }
      if (command === "docker" && args[0] === "stats") {
        return result({ timedOut: true, exitCode: null });
      }
      return result();
    });
    const collector = new OsSystemMetricsCollector();

    const metrics = await collector.collect();

    expect(metrics.dockerReachable).toBe(false);
    expect(metrics.containers).toHaveLength(1);
    expect(metrics.containers[0].memUsageMb).toBeNull();
  });

  it("devolve disco nulo (sem quebrar) quando a consulta de disco falha", async () => {
    withHealthyDocker();
    mockedRunCommand.mockImplementation(async (command: string, args: string[]) => {
      if (command === DISK_COMMAND) {
        return result({ exitCode: 1, stderr: "erro de disco" });
      }
      if (command === "docker" && args[0] === "ps") {
        return result({ stdout: "korrelo-app-1|Up 2 hours\n" });
      }
      if (command === "docker" && args[0] === "stats") {
        return result({ stdout: "korrelo-app-1|120.5MiB / 512MiB|3.5%\n" });
      }
      return result();
    });
    const collector = new OsSystemMetricsCollector();

    const metrics = await collector.collect();

    expect(metrics.diskTotalGb).toBeNull();
    expect(metrics.diskFreeGb).toBeNull();
    expect(metrics.usedDiskPercent).toBeNull();
  });
});
