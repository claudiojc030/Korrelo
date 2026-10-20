/**
 * Rollback RESOURCE-SAFE + `npm ci`.
 *
 * Regressão do risco apontado na revisão do commit a0983b4: o relatório
 * dizia que "o rollback compila com nice/heap, mas nunca é abortado por
 * recurso". Ou seja: um rollout interrompido porque o host entrou em
 * pressão podia iniciar OUTRO build pesado no rollback e competir com
 * Mesatta/Mongo.
 *
 * O que precisa ser garantido:
 * - falha ANTES do git update -> nenhum rollback (nada foi alterado);
 * - falha DEPOIS do git update e ANTES do restart de PM2 -> o Core em
 *   execução fica na versão anterior; sem build pesado e sem restart de
 *   PM2 quando faltam recursos;
 * - falha DEPOIS do restart de PM2 -> recovery_required/critical, sem
 *   sacrificar os projetos;
 * - a produção Docker tem PRIORIDADE sobre o painel do Korrelo;
 * - o install é `npm ci` (determinístico), sem fallback para `npm install`;
 * - nada é descartado em silêncio (lockfile modificado é detectado e
 *   reportado).
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const os = require("node:os");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const LIBS = path.resolve(__dirname, "..", "..", "..", "scripts", "rollout", "lib");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rolloutLib = require(path.join(LIBS, "rollout.cjs"));

import { createFakeToolchain } from "./testing/resource-fixtures";

type RunResult = { code: number; stdout: string; stderr: string; timedOut?: boolean };
type Call = { command: string; args: string[]; cwd?: string; env?: Record<string, string> };

const OK_RESOURCES = {
  memAvailableMb: 2305,
  memTotalMb: 3915,
  swapUsedMb: 120,
  swapTotalMb: 2047,
  load1: 0.4,
  load5: 0.3,
  load15: 0.2,
  diskAvailableGb: 12.5,
  diskTotalGb: 40,
  measurable: true,
};

const LOW_RESOURCES = { ...OK_RESOURCES, memAvailableMb: 250 };

describe("rollout - rollback resource-safe e npm ci", () => {
  let tmpDir: string;
  let calls: Call[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-rollback-safe-"));
    calls = [];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(overrides: Record<string, unknown> = {}) {
    const repoRoot = path.join(tmpDir, "repo");
    const coreDbPath = path.join(repoRoot, "apps", "api", "prisma", "dev.db");
    fs.mkdirSync(path.dirname(coreDbPath), { recursive: true });
    fs.writeFileSync(coreDbPath, "sqlite");
    fs.writeFileSync(path.join(repoRoot, "apps", "api", ".env"), "JWT_SECRET=x");
    fs.writeFileSync(path.join(repoRoot, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
    // Toolchain de build (typescript/tsc).
    createFakeToolchain(repoRoot);
    // Artefato do Core em execução (o que o snapshot deve capturar).
    fs.mkdirSync(path.join(repoRoot, "apps", "api", "dist"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "apps", "api", "dist", "main.js"), "// versao antiga\n");
    return {
      repoRoot,
      executorRoot: repoRoot,
      targetRepoRoot: repoRoot,
      coreDbPath,
      coreEnvPath: path.join(repoRoot, "apps", "api", ".env"),
      coreBackupDir: path.join(tmpDir, "backups"),
      artifactBackupDir: path.join(tmpDir, "artifacts"),
      projects: [{ name: "korrelo-mesatta-8452004c" }],
      pm2Apps: ["korrelo-api", "korrelo-web"],
      apiHealthUrl: "http://127.0.0.1:3001/health",
      webHealthUrl: "http://127.0.0.1:3000/",
      lockPath: path.join(tmpDir, "self-update.lock"),
      drainFilePath: path.join(tmpDir, "worker-drain"),
      statusDir: path.join(tmpDir, "rollouts"),
      ...overrides,
    };
  }

  function makeRunner(
    options: {
      buildFails?: boolean;
      healthFails?: boolean;
      lockModifiedAfterInstall?: boolean;
    } = {},
  ) {
    // Contador de restarts do PM2: o health da API falha durante a fase do
    // rollout e volta a funcionar na fase do rollback (2o restart).
    let pm2Restarts = 0;
    let installDone = false;
    return async (
      command: string,
      args: string[] = [],
      opts: { cwd?: string; env?: Record<string, string> } = {},
    ): Promise<RunResult> => {
      calls.push({ command, args, cwd: opts.cwd, env: opts.env });

      let realCommand = command;
      let realArgs = args;
      if (realCommand === "nice") {
        realCommand = realArgs[2] ?? "";
        realArgs = realArgs.slice(3);
      }
      if (realCommand === "ionice") {
        realCommand = realArgs[2] ?? "";
        realArgs = realArgs.slice(3);
      }

      if (realCommand === "nice" || realCommand === "ionice") {
        return { code: 0, stdout: "", stderr: "" };
      }

      if (realCommand === "git") {
        const gitArgs = realArgs[0] === "-C" ? realArgs.slice(2) : realArgs;
        if (gitArgs[0] === "status") {
          // Depois do install, simula o lockfile modificado.
          if (installDone && options.lockModifiedAfterInstall) {
            return { code: 0, stdout: " M package-lock.json\n", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--is-inside-work-tree") return { code: 0, stdout: "true\n", stderr: "" };
        if (gitArgs[0] === "branch" && gitArgs[1] === "--show-current") return { code: 0, stdout: "main\n", stderr: "" };
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--verify") return { code: 0, stdout: "c2c2c2c\n", stderr: "" };
        if (gitArgs[0] === "rev-parse") return { code: 0, stdout: "c1c1c1c\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      }

      if (realCommand === "sqlite3") {
        const sql = String(realArgs[1] ?? "");
        if (sql.startsWith(".backup")) {
          const dest = /'([^']+)'/.exec(sql)?.[1];
          if (dest) fs.writeFileSync(dest, "backup");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (sql.startsWith("PRAGMA integrity_check")) return { code: 0, stdout: "ok\n", stderr: "" };
        if (sql.includes("DeployJob")) return { code: 0, stdout: "0\n", stderr: "" };
        return { code: 0, stdout: "1\n", stderr: "" };
      }

      if (realCommand === "docker") {
        if (realArgs[0] === "ps") return { code: 0, stdout: "korrelo-mesatta-8452004c\n", stderr: "" };
        if (realArgs[0] === "inspect") {
          return {
            code: 0,
            stdout: JSON.stringify({
              Name: "/korrelo-mesatta-8452004c",
              Id: "3f1c9a2b7d4e5f60718293a4b5c6d7e8f9012345678abcdef0123456789abcdef",
              Config: { Image: "korrelo-mesatta:commit-mesatta" },
              HostConfig: {
                Memory: 1757 * 1024 * 1024,
                MemorySwap: 3514 * 1024 * 1024,
                RestartPolicy: { Name: "unless-stopped" },
              },
              NetworkSettings: { Networks: { "korrelo-shared": {} }, Ports: { "3002/tcp": [] } },
              Mounts: [],
              RestartCount: 0,
              State: { Status: "running", Running: true, StartedAt: "2026-10-19T10:00:00.000000000Z" },
            }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      }

      if (realCommand === "npm") {
        if (realArgs[0] === "ci") {
          installDone = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (realArgs[0] === "run" && realArgs[1] === "build") {
          return options.buildFails
            ? { code: 1, stdout: "", stderr: "build falhou (sem memória)" }
            : { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }

      if (realCommand === "curl") {
        const url = String(realArgs[realArgs.length - 1] ?? "");
        if (options.healthFails && url.includes("3001") && pm2Restarts < 2) {
          return { code: 7, stdout: "", stderr: "falhou" };
        }
        return { code: 0, stdout: "ok", stderr: "" };
      }

      if (realCommand === "pm2") {
        if (realArgs[0] === "restart") pm2Restarts += 1;
        return { code: 0, stdout: "", stderr: "" };
      }

      return { code: 0, stdout: "", stderr: "" };
    };
  }

  /** Sequência de leituras de recursos. */
  function reader(sequence: Record<string, unknown>[]) {
    let index = 0;
    return async () => {
      const item = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      return { ...OK_RESOURCES, ...item };
    };
  }

  /** Cooldown curto e sem dormir de verdade (o teste não espera 10s). */
  const TEST_WAIT = { intervalSec: 1, timeoutSec: 2 };
  const instantSleep = async () => undefined;
  /** Janela de health curta (o rollout nao espera 60s nos testes). */
  const TEST_HEALTH = { timeoutSec: 2, intervalSec: 1, initialDelaySec: 0 };

  /** Rollout de teste: cooldown curto e sleep instantâneo. */
  function runRollout(options: Record<string, unknown>) {
    return rolloutLib.executeRollout({
      sleep: instantSleep,
      waitConfig: TEST_WAIT,
      healthConfig: TEST_HEALTH,
      ...options,
    });
  }

  function unwrap(call: Call): { command: string; args: string[] } {
    let command = call.command;
    let args = call.args;
    if (command === "nice") {
      command = args[2] ?? "";
      args = args.slice(3);
    }
    if (command === "ionice") {
      command = args[2] ?? "";
      args = args.slice(3);
    }
    return { command, args };
  }

  function npmCalls() {
    return calls.filter((call) => unwrap(call).command === "npm");
  }

  function pm2Restarts() {
    return calls.filter((call) => call.command === "pm2" && call.args[0] === "restart");
  }

  it("1) pressão ANTES do git update: nenhum rollback (nada foi alterado)", async () => {
    const run = makeRunner();
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: reader([LOW_RESOURCES]),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Rollout adiado");
    expect(result.state.rollback?.skipped).toBe(true);
    // Nenhum checkout, nenhum build, nenhum restart de PM2.
    expect(calls.some((call) => call.command === "git" && call.args.includes("checkout"))).toBe(false);
    expect(npmCalls()).toHaveLength(0);
    expect(pm2Restarts()).toHaveLength(0);
  });

  it("2) pressão DEPOIS do git update: o rollback não dispara build pesado à força", async () => {
    const run = makeRunner({ buildFails: true });
    // Leituras: preflight, install, build-shared, build-api (falha) e o
    // rollback (pressão).
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: reader([OK_RESOURCES, OK_RESOURCES, OK_RESOURCES, OK_RESOURCES, LOW_RESOURCES]),
    });

    expect(result.ok).toBe(false);
    expect(result.state.rollback?.deferred).toBe(true);
    expect(result.state.rollback?.status).toBe("RECOVERY_DEFERRED");
    // O checkout do alvo volta para o previousCommit (barato e seguro)...
    const checkout = calls.find((call) => call.command === "git" && call.args.includes("checkout"));
    expect(checkout).toBeDefined();
    // ... mas NENHUM build pesado foi iniciado no rollback.
    const rollbackBuilds = npmCalls().filter((call) => unwrap(call).args.includes("build"));
    // Só o build do rollout (shared-types) chegou a rodar antes da falha.
    expect(rollbackBuilds.length).toBeLessThanOrEqual(1);
    expect(result.state.recoveryRequired).toBe(false);
  });

  it("3) PM2 antigo ainda executando: o rollback não reinicia o PM2", async () => {
    const run = makeRunner({ buildFails: true });
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: reader([OK_RESOURCES, OK_RESOURCES, OK_RESOURCES, OK_RESOURCES, LOW_RESOURCES]),
    });

    expect(result.ok).toBe(false);
    expect(result.state.rollback?.deferred).toBe(true);
    // Nenhum restart de PM2 (o Core em execução continua na versão antiga).
    expect(pm2Restarts()).toHaveLength(0);
    expect(result.state.rollback?.reason).toContain("Core em execução permaneceu na versão anterior");
  });

  it("4) rollback pós-PM2 também respeita a segurança dos projetos", async () => {
    const run = makeRunner({ healthFails: true });
    const result = await runRollout({
      config: makeConfig(),
      run,
      // O PM2 restart acontece; a pressão aparece no rollback.
      readResources: reader([
        OK_RESOURCES,
        OK_RESOURCES,
        OK_RESOURCES,
        OK_RESOURCES,
        OK_RESOURCES,
        LOW_RESOURCES,
      ]),
    });

    expect(result.ok).toBe(false);
    expect(result.state.rollback?.deferred).toBe(true);
    expect(result.state.rollback?.status).toBe("RECOVERY_REQUIRED");
    expect(result.state.recoveryRequired).toBe(true);
    expect(result.state.recoveryCritical).toBe(true);
    // Nenhum comando Docker de escrita (os projetos não são tocados).
    for (const call of calls) {
      if (call.command !== "docker") continue;
      expect(["rm", "rmi", "stop", "start", "restart", "kill", "update", "run", "create", "up", "down", "exec", "compose"]).not.toContain(
        call.args[0],
      );
    }
  });

  it("5) falta de recurso durante o recovery nunca toca o Docker dos projetos", async () => {
    const run = makeRunner({ healthFails: true });
    await runRollout({
      config: makeConfig(),
      run,
      readResources: reader([OK_RESOURCES, OK_RESOURCES, OK_RESOURCES, OK_RESOURCES, OK_RESOURCES, LOW_RESOURCES]),
    });

    const dockerCalls = calls.filter((call) => call.command === "docker");
    expect(dockerCalls.length).toBeGreaterThan(0);
    for (const call of dockerCalls) {
      expect(["ps", "inspect", "stats", "version", "info"]).toContain(call.args[0]);
    }
  });

  it("6) Mesatta tem prioridade sobre a recuperação do Core", async () => {
    const run = makeRunner({ healthFails: true });
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: reader([OK_RESOURCES, OK_RESOURCES, OK_RESOURCES, OK_RESOURCES, OK_RESOURCES, LOW_RESOURCES]),
    });

    expect(result.state.rollback?.reason).toContain("NÃO foram tocados");
    expect(result.state.rollback?.reason).toContain("não serão sacrificados");
    // Nenhum stop/restart/rm de container.
    for (const call of calls) {
      if (call.command !== "docker") continue;
      expect(["stop", "restart", "rm", "kill", "rmi", "update"]).not.toContain(call.args[0]);
    }
  });

  it("7) o install usa npm ci", async () => {
    const run = makeRunner();
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: reader([OK_RESOURCES]),
    });

    expect(result.ok).toBe(true);
    const install = npmCalls().find((call) => unwrap(call).args[0] === "ci");
    expect(install).toBeDefined();
  });

  it("8) npm install NÃO aparece no rollout", async () => {
    const run = makeRunner();
    await runRollout({
      config: makeConfig(),
      run,
      readResources: reader([OK_RESOURCES]),
    });

    for (const call of npmCalls()) {
      expect(unwrap(call).args[0]).not.toBe("install");
    }
    const lib = fs.readFileSync(path.join(LIBS, "rollout.cjs"), "utf-8");
    expect(lib).not.toContain('"install"]');
  });

  it("9) package-lock ausente: aborta com mensagem clara (sem fallback para npm install)", async () => {
    const config = makeConfig();
    fs.rmSync(path.join(config.repoRoot, "package-lock.json"));
    const run = makeRunner();
    const result = await runRollout({
      config,
      run,
      readResources: reader([OK_RESOURCES]),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("package-lock.json não encontrado");
    expect(result.error).toContain("npm ci");
    expect(result.error).toContain("NÃO cai para 'npm install'");
    // Nenhum install de qualquer tipo.
    expect(npmCalls().filter((call) => unwrap(call).args[0] === "ci" || unwrap(call).args[0] === "install")).toHaveLength(0);
  });

  it("10) lockfile modificado após o install: detectado e reportado, nunca descartado", async () => {
    const config = makeConfig();
    const run = makeRunner({ lockModifiedAfterInstall: true });
    const result = await runRollout({
      config,
      run,
      readResources: reader([OK_RESOURCES]),
    });

    // O rollout segue (não descarta nada), mas reporta.
    expect(result.state.worktreeModifiedAfterInstall).toEqual(["package-lock.json"]);
    const stages = result.stages as { id: string; status: string; detail: string | null }[];
    const worktreeStage = stages.find((stage) => stage.id === "worktree-check");
    expect(worktreeStage?.status).toBe("warn");
    expect(worktreeStage?.detail).toContain("nada foi descartado");
    // E o arquivo continua lá (não foi resetado).
    expect(fs.existsSync(path.join(config.repoRoot, "package-lock.json"))).toBe(true);
  });

  it("11) o bootstrap com --repo-root continua funcionando", async () => {
    const target = path.join(tmpDir, "target");
    const executor = path.join(tmpDir, "executor");
    for (const dir of [target, executor]) {
      fs.mkdirSync(path.join(dir, "apps", "api", "prisma"), { recursive: true });
      fs.writeFileSync(path.join(dir, "apps", "api", "prisma", "dev.db"), "sqlite");
      fs.writeFileSync(path.join(dir, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
      createFakeToolchain(dir);
    }
    const config = makeConfig({
      repoRoot: target,
      executorRoot: executor,
      targetRepoRoot: target,
      coreDbPath: path.join(target, "apps", "api", "prisma", "dev.db"),
      coreEnvPath: path.join(target, "apps", "api", ".env"),
    });

    const run = makeRunner();
    const result = await runRollout({
      config,
      run,
      readResources: reader([OK_RESOURCES]),
    });

    expect(result.ok).toBe(true);
    for (const call of npmCalls()) {
      expect(call.cwd).toBe(target);
    }
  });

  it("12) o dry-run continua read-only (nenhum lock, drain, status ou backup)", async () => {
    const config = makeConfig();
    const run = makeRunner();
    const result = await runRollout({
      config,
      run,
      dryRun: true,
      readResources: reader([OK_RESOURCES]),
    });

    expect(result.dryRun).toBe(true);
    expect(fs.existsSync(config.lockPath)).toBe(false);
    expect(fs.existsSync(config.drainFilePath)).toBe(false);
    expect(fs.existsSync(config.statusDir)).toBe(false);
    expect(fs.existsSync(config.coreBackupDir)).toBe(false);
    expect(npmCalls()).toHaveLength(0);
  });

  it("13) o resource guard continua funcionando (pressão aborta antes do install)", async () => {
    const run = makeRunner();
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: reader([LOW_RESOURCES]),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Rollout adiado");
    expect(npmCalls().filter((call) => unwrap(call).args[0] === "ci")).toHaveLength(0);
  });

  it("14) fluxo normal com recursos suficientes continua completo", async () => {
    const run = makeRunner();
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: reader([OK_RESOURCES]),
    });

    expect(result.ok).toBe(true);
    expect(result.state.projectIntegrityCheck).toBe("intacto");
    expect(result.state.rollback).toBeUndefined();
    // O PM2 do Core foi reiniciado (só ele).
    const restarts = pm2Restarts();
    expect(restarts.length).toBeGreaterThan(0);
    for (const call of restarts) {
      expect(call.args.slice(1)).toEqual(["korrelo-api", "korrelo-web"]);
    }
  });
});

export {};
