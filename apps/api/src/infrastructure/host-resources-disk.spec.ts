import { runCommand } from "./command-runner";
import { realHostResourceProvider } from "./host-resources";

jest.mock("./command-runner", () => ({ runCommand: jest.fn() }));

const mockedRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;

function result(overrides: Partial<Awaited<ReturnType<typeof runCommand>>> = {}) {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
    durationMs: 2,
    ...overrides,
  };
}

describe("realHostResourceProvider.getDiskFreeMb", () => {
  beforeEach(() => mockedRunCommand.mockReset());

  it("lê o disponível em formato POSIX e devolve MB", async () => {
    mockedRunCommand.mockResolvedValue(
      result({
        stdout:
          "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 50000000 25000000 25000000 50% /\n",
      }),
    );

    await expect(realHostResourceProvider.getDiskFreeMb()).resolves.toBe(24_414);
    expect(mockedRunCommand).toHaveBeenCalledWith("df", ["-kP", "/"], { timeoutMs: 5_000 });
  });

  it("disco cheio devolve 0 (não null)", async () => {
    mockedRunCommand.mockResolvedValue(
      result({
        stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 1000 0 100% /\n",
      }),
    );

    await expect(realHostResourceProvider.getDiskFreeMb()).resolves.toBe(0);
  });

  it("timeout ou saída inválida devolve null (fail-closed)", async () => {
    mockedRunCommand.mockResolvedValueOnce(result({ timedOut: true, exitCode: null }));
    await expect(realHostResourceProvider.getDiskFreeMb()).resolves.toBeNull();

    mockedRunCommand.mockResolvedValueOnce(result({ stdout: "sem colunas" }));
    await expect(realHostResourceProvider.getDiskFreeMb()).resolves.toBeNull();
  });
});
