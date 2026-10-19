import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCommand } from "./command-runner";

describe("runCommand", () => {
  it("devolve stdout e exit code 0", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "process.stdout.write('ok')"],
      { timeoutMs: 10_000 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("devolve exit code diferente de zero sem lançar", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "process.stderr.write('boom'); process.exit(3)"],
      { timeoutMs: 10_000 },
    );

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("boom");
    expect(result.timedOut).toBe(false);
  });

  it("encerra o processo quando o timeout estoura", async () => {
    const startedAt = Date.now();
    const result = await runCommand(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)"],
      { timeoutMs: 300, killGraceMs: 200 },
    );

    expect(result.timedOut).toBe(true);
    // Resolve rápido: não fica esperando o processo se recusar a morrer.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("o processo é realmente encerrado (não fica rodando em segundo plano)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-cmd-"));
    const marker = path.join(tmpDir, "marker.txt");

    // O processo escreve o arquivo depois de 1,5s. Se ele for realmente
    // encerrado no timeout, o arquivo nunca aparece.
    await runCommand(
      process.execPath,
      ["-e", `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 1500)`],
      { timeoutMs: 200, killGraceMs: 200 },
    );

    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(fs.existsSync(marker)).toBe(false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejeita quando o binário não existe", async () => {
    await expect(
      runCommand("comando-que-nao-existe-korrelo-teste", [], { timeoutMs: 5_000 }),
    ).rejects.toThrow(/Falha ao executar/);
  });

  it("corta a saída que passa do limite de buffer", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(200000))"],
      { timeoutMs: 10_000, maxBufferBytes: 1_000 },
    );

    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThan(200_000);
  });
});
