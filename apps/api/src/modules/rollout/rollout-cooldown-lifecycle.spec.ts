/**
 * O PROCESSO DO ROLLOUT TEM QUE SOBREVIVER AO COOLDOWN.
 *
 * Incidente real (produção): durante o build-shared, o resource guard
 * detectou load1=3.54 > 1.5 e imprimiu
 *
 *   [rollout] build-shared: aguardando recursos
 *   tentativa=1
 *   próxima checagem em 10s
 *
 * e IMEDIATAMENTE voltou ao shell com exit code 0. O rollout morreu no
 * meio: Git ficou avançado no candidate, o PM2 seguia na versão anterior e
 * o self-update.lock / worker-drain ficaram órfãos.
 *
 * Causa: `defaultSleep` fazia `timer.unref?.()`. Durante o cooldown o timer
 * do sleep é o ÚNICO handle ativo do rollout; com unref, o Node não mantém
 * o event loop vivo, o processo termina NORMALMENTE (exit 0) e o cooldown
 * nunca termina.
 *
 * Estes testes são REAIS (processo Node filho), não com sleep fake: só um
 * processo de verdade revela o exit antecipado.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const os = require("node:os");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { spawn } = require("node:child_process");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const LIBS = path.resolve(__dirname, "..", "..", "..", "scripts", "rollout", "lib");

const LAUNCHER = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "scripts",
  "self-update",
  "launch-detached.cjs",
);

const GUARD_PATH = path.join(LIBS, "resource-guard.cjs");

describe("rollout - o processo vive durante o cooldown de recursos", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-cooldown-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Executa um script Node filho e devolve {code, stdout, stderr}. */
  function runNode(script: string, args: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [script, ...args], { cwd: tmpDir });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  }

  it("1) defaultSleep mantém o processo vivo (o marcador é escrito DEPOIS do sleep)", async () => {
    const marker = path.join(tmpDir, "marker.txt");
    const script = path.join(tmpDir, "sleeper.js");
    fs.writeFileSync(
      script,
      [
        `const guard = require(${JSON.stringify(GUARD_PATH)});`,
        `(async () => {`,
        `  await guard.defaultSleep(250);`,
        `  require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ok");`,
        `  console.log("sleep concluded");`,
        `})();`,
      ].join("\n"),
    );

    const result = await runNode(script);

    // O processo só pode terminar DEPOIS do sleep (com a implementação
    // antiga - unref - ele terminava na hora, sem escrever o marcador).
    expect(result.code).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
    expect(result.stdout).toContain("sleep concluded");
  }, 15000);

  it("2) o cooldown real (3.54 -> 2.4 -> 1.2) não encerra o processo e só compila com load <= 1.5", async () => {
    const resultFile = path.join(tmpDir, "result.json");
    const script = path.join(tmpDir, "cooldown.js");
    fs.writeFileSync(
      script,
      [
        `const guard = require(${JSON.stringify(GUARD_PATH)});`,
        `const loads = [3.54, 2.4, 1.2];`,
        `let index = 0;`,
        `const started = Date.now();`,
        `(async () => {`,
        `  const wait = await guard.waitForSafeResources({`,
        `    readHost: async () => ({ memAvailableMb: 2305, swapUsedMb: 120, load1: loads[Math.min(index++, loads.length - 1)], diskAvailableGb: 26.9, measurable: true }),`,
        `    thresholds: guard.readThresholds({}),`,
        `    waitConfig: { intervalSec: 0.05, timeoutSec: 5 },`,
        `    label: "build-shared",`,
        `  });`,
        `  require("node:fs").writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({`,
        `    ok: wait.ok,`,
        `    attempts: wait.attempts,`,
        `    elapsedMs: Date.now() - started,`,
        `    loadAtEnd: loads[Math.min(index, loads.length) - 1],`,
        `  }));`,
        `})();`,
      ].join("\n"),
    );

    const result = await runNode(script);

    expect(result.code).toBe(0);
    const payload = JSON.parse(fs.readFileSync(resultFile, "utf-8")) as {
      ok: boolean;
      attempts: number;
      elapsedMs: number;
      loadAtEnd: number;
    };

    // O cooldown aconteceu (3 leituras: 3.54, 2.4, 1.2) e o processo
    // NÃO encerrou na primeira espera.
    expect(payload.ok).toBe(true);
    expect(payload.attempts).toBe(3);
    expect(payload.loadAtEnd).toBe(1.2);
    // E o build só continuaria com load <= 1.5 (o último valor lido).
    expect(payload.loadAtEnd).toBeLessThanOrEqual(1.5);
    // O processo ficou vivo durante as esperas (o tempoElapsed prova).
    expect(payload.elapsedMs).toBeGreaterThanOrEqual(100);
  }, 20000);

  it("3) double fork: o rollout continua vivo durante o cooldown mesmo com o launcher já encerrado", async () => {
    const marker = path.join(tmpDir, "marker.txt");
    const runner = path.join(tmpDir, "runner.js");
    fs.writeFileSync(
      runner,
      [
        `const guard = require(${JSON.stringify(GUARD_PATH)});`,
        `const loads = [3.54, 2.4, 1.2];`,
        `let index = 0;`,
        `(async () => {`,
        `  const wait = await guard.waitForSafeResources({`,
        `    readHost: async () => ({ memAvailableMb: 2305, swapUsedMb: 120, load1: loads[Math.min(index++, loads.length - 1)], diskAvailableGb: 26.9, measurable: true }),`,
        `    thresholds: guard.readThresholds({}),`,
        `    waitConfig: { intervalSec: 0.05, timeoutSec: 5 },`,
        `    label: "build-shared",`,
        `  });`,
        `  require("node:fs").writeFileSync(${JSON.stringify(marker)}, wait.ok ? "ok" : "fail");`,
        `})();`,
      ].join("\n"),
    );

    const pidFile = path.join(tmpDir, "runner.pid");
    const logFile = path.join(tmpDir, "runner.log");

    // O launcher (que sai imediatamente) dispara o runner.
    const launcher = spawn(
      process.execPath,
      [
        LAUNCHER,
        "--pid-file",
        pidFile,
        "--log-file",
        logFile,
        "--cwd",
        tmpDir,
        "--",
        process.execPath,
        runner,
      ],
      { stdio: "ignore" },
    );
    await new Promise((resolve) => launcher.on("exit", resolve));

    // O launcher já morreu; o runner (neto) precisa concluir o cooldown.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.readFileSync(marker, "utf-8")).toBe("ok");
    // O PID do runner foi registrado (o drain/lock conseguem saber o dono).
    expect(fs.existsSync(pidFile)).toBe(true);
  }, 20000);

  it("4) o lock e o drain de um rollout que morreu no cooldown são limpos no startup", async () => {
    // O rollout morreu durante o cooldown: o lock e o drain ficaram com o PID
    // do processo morto.
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, "self-update.lock");
    const drainPath = path.join(stateDir, "worker-drain");
    const deadPid = 999_999_999;

    fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, acquiredAt: Date.now() }));
    fs.writeFileSync(
      drainPath,
      JSON.stringify({
        at: new Date().toISOString(),
        reason: "atualização do Korrelo",
        expiresAt: Date.now() + 30 * 60 * 1000,
        owner: "upd-1",
        pid: deadPid,
      }),
    );

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SelfUpdateRecoveryService } = require(
      path.resolve(__dirname, "..", "monitoring", "infrastructure", "self-update-recovery.service"),
    );
    process.env.KORRELO_STATE_DIR = stateDir;
    process.env.KORRELO_DRAIN_FILE = drainPath;
    try {
      const service = new SelfUpdateRecoveryService(
        { recoverInterruptedJobs: async () => [] } as never,
        { findLatest: async () => null } as never,
      );

      const result = service.cleanupStaleArtifacts();

      expect(result.lockRemoved).toBe(true);
      expect(result.drainRemoved).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(fs.existsSync(drainPath)).toBe(false);
    } finally {
      delete process.env.KORRELO_STATE_DIR;
      delete process.env.KORRELO_DRAIN_FILE;
    }
  });

  it("5) o sleep do resource guard NÃO usa unref (o timer precisa segurar o processo)", () => {
    const source = fs.readFileSync(GUARD_PATH, "utf-8");
    const start = source.indexOf("function defaultSleep");
    const end = source.indexOf("\nfunction ", start + 10);
    const sleepBlock = source.slice(start, end === -1 ? undefined : end);
    expect(sleepBlock).toContain("setTimeout(resolve, ms)");
    // O timer NÃO pode ser unref'd (a explicação no comentário pode citar
    // "unref", mas a chamada não pode existir).
    expect(sleepBlock).not.toContain("timer.unref");
    expect(sleepBlock).not.toMatch(/const timer = setTimeout/);
  });

  it("6) o unref do launcher e do command-runner continuam (e estão justificados)", () => {
    const launcher = fs.readFileSync(LAUNCHER, "utf-8");
    expect(launcher).toContain("child.unref()");
    expect(launcher).toContain("Desacopla");

    const runner = fs.readFileSync(path.join(LIBS, "command-runner.cjs"), "utf-8");
    expect(runner).toContain("timer.unref?.()");
    expect(runner).toContain("unref()` aqui é CORRETO");
  });
});
