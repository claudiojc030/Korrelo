import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { runCommand } from "./command-runner";

jest.mock("node:child_process", () => ({ spawn: jest.fn() }));

const mockedSpawn = spawn as unknown as jest.Mock;

/**
 * Processo filho simulado.
 *
 * `kill` é NO-OP e nenhum evento é emitido sozinho: representa o pior caso
 * real (processo em estado D, que ignora SIGKILL, ou neto segurando o pipe e
 * impedindo o evento `close`). Antes da correção, a promise do runCommand
 * ficava pendurada para sempre nesse cenário.
 */
class FakeChild extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = jest.fn(() => true);

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function makeChild(): FakeChild {
  const child = new FakeChild();
  mockedSpawn.mockReturnValue(child);
  return child;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("runCommand - garantia de assentamento", () => {
  beforeEach(() => {
    mockedSpawn.mockReset();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("processo que NUNCA emite close e ignora SIGKILL: a promise assenta no timeout", async () => {
    const child = makeChild();

    const result = await runCommand("docker", ["stats"], { timeoutMs: 40, killGraceMs: 30 });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGKILL");
    // Tentou encerrar de forma limpa e depois à força.
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("exit sem close (neto segurando o pipe): assenta com a saída já coletada", async () => {
    const child = makeChild();

    const promise = runCommand("docker", ["ps"], { timeoutMs: 5_000, killGraceMs: 30 });
    child.stdout.emit("data", "linha-1\n");
    // Processo saiu, mas o `close` nunca chega.
    child.emitExit(0, null);

    const result = await promise;

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("linha-1\n");
  });

  it("exit por sinal sem close preserva o sinal e não vira sucesso", async () => {
    const child = makeChild();

    const promise = runCommand("docker", ["stats"], { timeoutMs: 5_000, killGraceMs: 30 });
    child.emitExit(null, "SIGTERM");

    const result = await promise;

    // Sem `close` não há exit code; o sinal é preservado e timedOut é falso
    // (o timeout não disparou). Quem chama NÃO pode tratar como sucesso:
    // exitCode null !== 0.
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(result.timedOut).toBe(false);
  });

  it("close tardio depois do assentamento não altera o resultado", async () => {
    const child = makeChild();

    const result = await runCommand("docker", ["stats"], { timeoutMs: 30, killGraceMs: 20 });
    expect(result.timedOut).toBe(true);

    // Eventos atrasados do filho: ignorados pelo guard `settled`.
    child.emit("close", 0, null);
    child.emit("error", new Error("erro tardio"));
    await sleep(10);

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it("close normal continua assentando imediatamente (sem regressão)", async () => {
    const child = makeChild();

    const promise = runCommand("df", ["-k", "/"], { timeoutMs: 5_000 });
    child.stdout.emit("data", "ok\n");
    child.emit("close", 0, null);

    const result = await promise;

    expect(result).toMatchObject({ stdout: "ok\n", exitCode: 0, timedOut: false, truncated: false });
  });

  it("erro de spawn rejeita uma única vez", async () => {
    const child = makeChild();

    const promise = runCommand("nao-existe", [], { timeoutMs: 5_000 });
    child.emit("error", new Error("ENOENT"));
    child.emit("close", 1, null);

    await expect(promise).rejects.toThrow(/Falha ao executar/);
  });
});
