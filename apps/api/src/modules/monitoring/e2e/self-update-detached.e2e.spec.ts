/**
 * Self-update DESACOPLADO (Wave 3) - API.
 *
 * Incidente real: o rollout era filho do processo da API; o `pm2 restart
 * korrelo-api` matou a árvore da API e o rollout morreu junto (lock órfão,
 * drain órfão, snapshot-after/compare-projects/git-verify/worker-release
 * nunca aconteceram).
 *
 * O que precisa ser garantido:
 * - o update roda num processo DESACOPLADO (double fork) e sobrevive ao
 *   restart da API e do Web;
 * - o POST responde na hora (sem esperar o rollout);
 * - o job é persistente e recuperável depois de um restart;
 * - lock e drain órfãos são detectados (e só eles);
 * - dois updates concorrentes não acontecem;
 * - o startup classifica o update interrompido;
 * - nada de container de projeto é tocado.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScriptSelfUpdater } = require("../infrastructure/script-self-updater");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { FileSelfUpdateJobRepository } = require("../infrastructure/file-self-update-job.repository");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SelfUpdateRecoveryService } = require("../infrastructure/self-update-recovery.service");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lockLib = require("../../../../scripts/rollout/lib/self-update-lock.cjs");

const LAUNCHER = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "self-update",
  "launch-detached.cjs",
);


describe("self-update desacoplado (Wave 3)", () => {
  let tmpDir: string;
  let stateDir: string;
  let repoDir: string;
  let previousStateDir: string | undefined;
  let previousRepoDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-su-"));
    stateDir = path.join(tmpDir, "state");
    repoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });
    previousStateDir = process.env.KORRELO_STATE_DIR;
    previousRepoDir = process.env.KORRELO_REPO_DIR;
    process.env.KORRELO_STATE_DIR = stateDir;
    process.env.KORRELO_REPO_DIR = repoDir;
  });

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env.KORRELO_STATE_DIR;
    else process.env.KORRELO_STATE_DIR = previousStateDir;
    if (previousRepoDir === undefined) delete process.env.KORRELO_REPO_DIR;
    else process.env.KORRELO_REPO_DIR = previousRepoDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function fakeQueue(options: { activeJob?: boolean } = {}) {
    return {
      hasActiveJob: async () => options.activeJob === true,
      drain: async () => undefined,
      releaseDrain: async () => undefined,
      isDraining: () => false,
    };
  }

  function makeUpdater(queue = fakeQueue()): any {
    return new ScriptSelfUpdater(queue, new FileSelfUpdateJobRepository());
  }

  // ------------------------------------------------------- 1) POST responde
  it("1) o start devolve o jobId na hora (sem esperar o rollout)", async () => {
    const updater = makeUpdater();
    const startedAt = Date.now();
    const result = await updater.start();
    const elapsed = Date.now() - startedAt;

    // Responde com o id do job (a UI passa a acompanhar por polling).
    expect(result.jobId).toBeTruthy();
    expect(result.alreadyRunning).toBe(false);
    // E NÃO espera o rollout terminar (que levaria minutos).
    expect(elapsed).toBeLessThan(5_000);
  });

  it("1b) o job é persistido antes do runner começar", async () => {
    const repo = new FileSelfUpdateJobRepository();
    const updater = new ScriptSelfUpdater(fakeQueue(), repo);
    const result = await updater.start();

    const jobs = await repo.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(result.jobId);
    expect(["queued", "running"]).toContain(jobs[0].status);
  });

  // ------------------------------------- 2/3/4) o runner sobrevive à API
  it("2/3/4) o launcher desacopla o runner: ele sobrevive ao processo pai", async () => {
    const logFile = path.join(tmpDir, "runner.log");
    const pidFile = path.join(tmpDir, "runner.pid");

    // Um "runner" que fica vivo e grava um marcador quando termina.
    const marker = path.join(tmpDir, "marker.txt");
    const runnerScript = path.join(tmpDir, "runner.js");
    fs.writeFileSync(
      runnerScript,
      `setTimeout(() => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ok"); }, 1500);\n`,
    );

    // O "pai" morre logo depois de disparar (simula o pm2 restart da API).
    const parentScript = path.join(tmpDir, "parent.js");
    fs.writeFileSync(
      parentScript,
      [
        `const { spawn } = require("node:child_process");`,
        `const child = spawn(process.execPath, [${JSON.stringify(LAUNCHER)}, "--pid-file", ${JSON.stringify(pidFile)}, "--log-file", ${JSON.stringify(logFile)}, "--cwd", ${JSON.stringify(tmpDir)}, "--", process.execPath, ${JSON.stringify(runnerScript)}], { detached: true, stdio: "ignore" });`,
        `child.unref();`,
        `process.exit(0);`,
      ].join("\n"),
    );

    const parent = spawn(process.execPath, [parentScript], { stdio: "ignore" });
    await new Promise((resolve) => parent.on("exit", resolve));

    // O pai já morreu: o runner (neto) continua vivo.
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.existsSync(pidFile)).toBe(true);
  }, 15000);

  // -------------------------------------------------- 5/6/7) lock e drain
  it("5) lock com PID morto é classificado como STALE", () => {
    const lockPath = path.join(tmpDir, "self-update.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, acquiredAt: Date.now() }));

    expect(lockLib.isOrphaned(lockPath)).toBe(true);
  });

  it("7) lock de processo VIVO não é removido", () => {
    const lockPath = path.join(tmpDir, "self-update.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));

    expect(lockLib.isOrphaned(lockPath)).toBe(false);
  });

  it("6) drain órfão (TTL vencido) é removido; drain válido é mantido", () => {
    const drainPath = path.join(tmpDir, "worker-drain");
    const service = new SelfUpdateRecoveryService(
      { recoverInterruptedJobs: async () => [] } as never,
      { findLatest: async () => null } as never,
    );
    process.env.KORRELO_DRAIN_FILE = drainPath;

    // Drain expirado -> removido.
    fs.writeFileSync(drainPath, JSON.stringify({ at: new Date().toISOString(), expiresAt: Date.now() - 1000 }));
    expect(service.cleanupStaleArtifacts().drainRemoved).toBe(true);
    expect(fs.existsSync(drainPath)).toBe(false);

    // Drain válido (TTL no futuro) -> mantido.
    fs.writeFileSync(
      drainPath,
      JSON.stringify({ at: new Date().toISOString(), expiresAt: Date.now() + 600_000, pid: process.pid }),
    );
    expect(service.cleanupStaleArtifacts().drainRemoved).toBe(false);
    expect(fs.existsSync(drainPath)).toBe(true);

    delete process.env.KORRELO_DRAIN_FILE;
  });

  it("7b) lock órfão é removido; lock de processo vivo é mantido", () => {
    const service = new SelfUpdateRecoveryService(
      { recoverInterruptedJobs: async () => [] } as never,
      { findLatest: async () => null } as never,
    );
    const lockPath = path.join(stateDir, "self-update.lock");

    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999 }));
    expect(service.cleanupStaleArtifacts().lockRemoved).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);

    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));
    expect(service.cleanupStaleArtifacts().lockRemoved).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  // ------------------------------------------------ 8) updates concorrentes
  it("8) dois updates concorrentes: o segundo é recusado", async () => {
    const repo = new FileSelfUpdateJobRepository();
    const updater = new ScriptSelfUpdater(fakeQueue(), repo);

    // Simula um job em andamento (com runner vivo).
    const job = {
      id: "upd-1",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: "running" as const,
      executorCommit: null,
      previousCommit: null,
      candidateCommit: null,
      previousBranch: null,
      currentStage: null,
      progress: 10,
      pid: process.pid,
      result: null,
      failureReason: null,
      recoveryStatus: null,
      lastMessage: null,
    };
    await repo.save(job);

    const result = await updater.start();
    expect(result.alreadyRunning).toBe(true);
    expect(result.jobId).toBe("upd-1");
  });

  // -------------------------------------------- 9) polling após restart
  it("9) o job é recuperado depois de um 'restart' da API", async () => {
    const repo = new FileSelfUpdateJobRepository();
    await repo.save({
      id: "upd-9",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: "completed",
      executorCommit: "abc",
      previousCommit: "def",
      candidateCommit: "abc",
      previousBranch: "main",
      currentStage: "complete",
      progress: 100,
      pid: null,
      result: "success",
      failureReason: null,
      recoveryStatus: null,
      lastMessage: null,
    });

    // "Restart": um novo repositório aponta para o mesmo diretório.
    const afterRestart = new FileSelfUpdateJobRepository();
    const found = await afterRestart.findById("upd-9");
    expect(found?.status).toBe("completed");
    expect(found?.previousCommit).toBe("def");
    expect((await afterRestart.findLatest())?.id).toBe("upd-9");
  });

  // ------------------------------------------- 15) interrupted no startup
  it("15) o startup classifica o job interrompido (runner morto)", async () => {
    const repo = new FileSelfUpdateJobRepository();
    await repo.save({
      id: "upd-15",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: "running",
      executorCommit: null,
      previousCommit: null,
      candidateCommit: null,
      previousBranch: null,
      currentStage: "build-web",
      progress: 70,
      pid: 999_999_999,
      result: null,
      failureReason: null,
      recoveryStatus: null,
      lastMessage: null,
    });

    const updater = new ScriptSelfUpdater(fakeQueue(), repo);
    const recovered = await updater.recoverInterruptedJobs();

    expect(recovered).toHaveLength(1);
    expect(recovered[0].status).toBe("interrupted");
    expect(recovered[0].recoveryStatus).toBe("recovery_required");
  });

  it("15b) o startup NÃO mexe num job cujo runner está vivo", async () => {
    const repo = new FileSelfUpdateJobRepository();
    await repo.save({
      id: "upd-15b",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: "running",
      executorCommit: null,
      previousCommit: null,
      candidateCommit: null,
      previousBranch: null,
      currentStage: "build-web",
      progress: 70,
      pid: process.pid,
      result: null,
      failureReason: null,
      recoveryStatus: null,
      lastMessage: null,
    });

    const updater = new ScriptSelfUpdater(fakeQueue(), repo);
    expect(await updater.recoverInterruptedJobs()).toHaveLength(0);
  });

  // ------------------------------------------------ 16/17) logs persistem
  it("16) o log do job persiste em arquivo e sobrevive ao restart", async () => {
    const repo = new FileSelfUpdateJobRepository();
    await repo.save({
      id: "upd-16",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: "running",
      executorCommit: null,
      previousCommit: null,
      candidateCommit: null,
      previousBranch: null,
      currentStage: null,
      progress: 0,
      pid: null,
      result: null,
      failureReason: null,
      recoveryStatus: null,
      lastMessage: null,
    });
    fs.mkdirSync(repo.baseDir, { recursive: true });
    fs.writeFileSync(repo.logPath("upd-16"), "linha 1\nlinha 2\n");

    const afterRestart = new FileSelfUpdateJobRepository();
    expect(afterRestart.readLog("upd-16")).toContain("linha 2");
  });

  it("17) o log é limitado em tamanho", () => {
    const repo = new FileSelfUpdateJobRepository();
    fs.mkdirSync(repo.baseDir, { recursive: true });
    fs.writeFileSync(repo.logPath("upd-17"), "x".repeat(100_000));

    const log = repo.readLog("upd-17", 1000);
    expect(log.length).toBeLessThanOrEqual(1000);
  });

  // ------------------------------------------- 18/19/20) nada de projeto
  it("18/19/20) o self-update não toca em container de projeto", async () => {
    const lib = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "..", "..", "..", "..", "scripts", "self-update.sh"),
      "utf-8",
    );
    expect(lib).not.toContain("docker compose");
    expect(lib).not.toContain("docker rm");
    expect(lib).not.toContain("docker restart");
    expect(lib).not.toContain("docker stop");

    // E a API também não: o self-update só drena o worker e chama o script.
    const source = fs.readFileSync(path.resolve(__dirname, "..", "infrastructure", "script-self-updater.ts"), "utf-8");
    expect(source).not.toContain("docker restart");
    expect(source).not.toContain("docker compose");
  });

  it("23) o lock do rollout continua exigindo o commit anterior (nada de reset genérico)", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "..", "..", "scripts", "rollout", "lib", "git-state.cjs"),
      "utf-8",
    );
    expect(source).toContain("restoreTargetGitState");
    expect(source).toContain("reset");
    // O reset é só da BRANCH local, depois de validar o working tree.
    expect(source).toContain("working tree contém alterações inesperadas");
  });

  it("o launcher é um double fork (o runner não é descendente da API)", () => {
    const source = fs.readFileSync(LAUNCHER, "utf-8");
    expect(source).toContain("detached: true");
    expect(source).toContain("unref");
    // E o launcher sai imediatamente (é o runner que fica vivo).
    expect(source).toContain("process.exit(0)");
  });
});
