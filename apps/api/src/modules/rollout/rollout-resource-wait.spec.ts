/**
 * RESOURCE COOLDOWN + ROLLBACK PRESERVANDO A BRANCH.
 *
 * Contexto real (primeiro rollout na VPS):
 * - o `npm ci` terminou e o load1 ficou em 3.19 (limite 1.5) -> o resource
 *   guard abortou o build-shared e o rollout entrou em RECOVERY_DEFERRED;
 * - poucos minutos depois, sem fazer nada, o load1 caiu para 0.77: a pressão
 *   era TRANSITÓRIA e o abort foi um timeout evitável;
 * - o rollback restaurou o commit (af1205a) mas deixou o checkout em
 *   DETACHED HEAD (a branch main continuava no commit novo) -> o operador
 *   precisou de `git checkout main` + `git reset --hard` na mão.
 *
 * O que precisa ser garantido:
 * - pressão TRANSITÓRIA espera o host normalizar (cooldown, sem busy loop);
 * - pressão que não normaliza aborta (timeout) e entra no recovery seguro;
 * - o rollback/recovery NUNCA termina em detached HEAD: branch + commit
 *   restaurados;
 * - working tree inesperado IMPEDE a restauração automática (nada de reset
 *   destrutivo);
 * - a produção (Mesatta/Mongo/Evolution) tem prioridade sobre o Core;
 * - os thresholds de produção continuam os mesmos.
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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const guard = require(path.join(LIBS, "resource-guard.cjs"));

type RunResult = { code: number; stdout: string; stderr: string; timedOut?: boolean };
type Call = { command: string; args: string[]; cwd?: string; env?: Record<string, string> };

const SAFE = {
  memAvailableMb: 2305,
  memTotalMb: 3915,
  swapUsedMb: 120,
  swapTotalMb: 2047,
  load1: 0.32,
  load5: 0.3,
  load15: 0.2,
  diskAvailableGb: 26.9,
  diskTotalGb: 40,
  measurable: true,
};

describe("rollout - cooldown de recursos e rollback preservando a branch", () => {
  let tmpDir: string;
  let calls: Call[];
  let logs: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-cooldown-"));
    calls = [];
    logs = [];
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
      dirtyDuringRecovery?: string[];
    } = {},
  ) {
    let healthAlreadyFailed = false;
    let installDone = false;
    let checkoutDone = false;
    // O HEAD do checkout alvo: avança no pull e volta no reset.
    let head = "c1c1c1c";
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
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--is-inside-work-tree") {
          return { code: 0, stdout: "true\n", stderr: "" };
        }
        if (gitArgs[0] === "branch" && gitArgs[1] === "--show-current") {
          return { code: 0, stdout: "main\n", stderr: "" };
        }
        if (gitArgs[0] === "status") {
          // A checagem do recovery usa --untracked-files=no (dá para
          // distinguir da checagem de pós-install).
          if (
            checkoutDone === false &&
            options.dirtyDuringRecovery &&
            options.dirtyDuringRecovery.length > 0 &&
            gitArgs.includes("--untracked-files=no")
          ) {
            return {
              code: 0,
              stdout: options.dirtyDuringRecovery.map((file) => ` M ${file}\n`).join(""),
              stderr: "",
            };
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (gitArgs[0] === "checkout") {
          checkoutDone = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (gitArgs[0] === "reset") {
          head = gitArgs[gitArgs.length - 1] ?? head;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (gitArgs[0] === "pull") {
          head = "c2c2c2c";
          return { code: 0, stdout: "", stderr: "" };
        }
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--verify") return { code: 0, stdout: "c2c2c2c\n", stderr: "" };
        if (gitArgs[0] === "rev-parse") return { code: 0, stdout: `${head}\n`, stderr: "" };
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
            ? { code: 1, stdout: "", stderr: "build falhou" }
            : { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }

      if (realCommand === "curl") {
        const url = String(realArgs[realArgs.length - 1] ?? "");
        if (options.healthFails && url.includes("3001") && !healthAlreadyFailed) {
          healthAlreadyFailed = true;
          return { code: 7, stdout: "", stderr: "falhou" };
        }
        return { code: 0, stdout: "ok", stderr: "" };
      }

      void installDone;
      return { code: 0, stdout: "", stderr: "" };
    };
  }

  /** Sequência de métricas por leitura (o cooldown reusa a última quando acaba). */
  function reader(sequence: Record<string, unknown>[]) {
    let index = 0;
    return async () => {
      const item = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      return { ...SAFE, ...item };
    };
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

  function dockerCalls() {
    return calls.filter((call) => call.command === "docker");
  }

  const TEST_WAIT = { intervalSec: 1, timeoutSec: 10 };
  const TEST_WAIT_SHORT = { intervalSec: 1, timeoutSec: 2 };
  const instantSleep = async () => undefined;

  function runRollout(options: Record<string, unknown>) {
    return rolloutLib.executeRollout({
      sleep: instantSleep,
      waitConfig: TEST_WAIT,
      log: (line: string) => logs.push(line),
      ...options,
    });
  }

  it("1) pressão TRANSITÓRIA normaliza: o rollout continua", async () => {
    const run = makeRunner();
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: reader([{ load1: 0.32 }, { load1: 3.19 }, { load1: 2.4 }, { load1: 1.3 }]),
    });

    expect(result.ok).toBe(true);
    // Houve espera (o log mostra) e o rollout terminou.
    expect(logs.some((line) => line.includes("aguardando recursos"))).toBe(true);
    expect(logs.some((line) => line.includes("recursos normalizados"))).toBe(true);
  });

  it("2) pressão que NÃO normaliza: timeout aborta antes do build", async () => {
    const run = makeRunner();
    const result = await runRollout({
      config: makeConfig(),
      run,
      waitConfig: TEST_WAIT_SHORT,
      readResources: reader([{ load1: 3.2 }]),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Rollout adiado");
    expect(result.state.resourceCheck?.timeout).toBe(true);
    // Nenhum build começou.
    expect(npmCalls().filter((call) => unwrap(call).args.includes("build"))).toHaveLength(0);
  });

  it("3) o build não inicia enquanto o host está inseguro", async () => {
    const run = makeRunner();
    let loadAtBuild: number | null = null;
    let currentLoad = 0.32;
    const sequence = [0.32, 0.32, 3.19, 2.4, 1.3];
    let index = 0;
    const readResources = async () => {
      currentLoad = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      return { ...SAFE, load1: currentLoad };
    };
    const result = await runRollout({
      config: makeConfig(),
      run: async (command: string, args: string[] = [], opts: Record<string, unknown> = {}) => {
        const real = unwrap({ command, args });
        if (real.command === "npm" && real.args.includes("build")) loadAtBuild = currentLoad;
        return run(command, args, opts as never);
      },
      readResources,
    });

    expect(result.ok).toBe(true);
    // O primeiro build só começou com load <= 1.5.
    expect(loadAtBuild).not.toBeNull();
    expect(loadAtBuild as unknown as number).toBeLessThanOrEqual(1.5);
  });

  it("4) o intervalo do cooldown é configurável", () => {
    const config = guard.readWaitConfig({ KORRELO_ROLLOUT_RESOURCE_WAIT_INTERVAL_SEC: "25" });
    expect(config.intervalSec).toBe(25);
    expect(guard.readWaitConfig({}).intervalSec).toBe(10);
  });

  it("5) o timeout do cooldown é configurável", () => {
    const config = guard.readWaitConfig({ KORRELO_ROLLOUT_RESOURCE_WAIT_TIMEOUT_SEC: "600" });
    expect(config.timeoutSec).toBe(600);
    expect(guard.readWaitConfig({}).timeoutSec).toBe(180);
  });

  it("6) sem busy loop: o cooldown dorme entre as checagens", async () => {
    const sleeps: number[] = [];
    const wait = await guard.waitForSafeResources({
      readHost: async () => ({ ...SAFE, load1: 3.19 }),
      thresholds: guard.readThresholds({}),
      waitConfig: { intervalSec: 10, timeoutSec: 30 },
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    expect(wait.ok).toBe(false);
    expect(wait.timeout).toBe(true);
    // 10s, 10s, 10s (e para no timeout de 30s) - nada de loop apertado.
    expect(sleeps).toEqual([10_000, 10_000, 10_000]);
    expect(wait.elapsedSec).toBe(30);
  });

  it("7) npm ci -> espera -> build-shared", async () => {
    const run = makeRunner();
    const order: string[] = [];
    const result = await runRollout({
      config: makeConfig(),
      run: async (command: string, args: string[] = [], opts: Record<string, unknown> = {}) => {
        const real = unwrap({ command, args });
        if (real.command === "npm") order.push(real.args[0] === "ci" ? "ci" : `build:${real.args[2] ?? ""}`);
        return run(command, args, opts as never);
      },
      readResources: reader([{ load1: 0.32 }, { load1: 0.32 }, { load1: 3.19 }, { load1: 1.2 }]),
    });

    expect(result.ok).toBe(true);
    expect(order[0]).toBe("ci");
    expect(order[1]).toContain("packages/shared-types");
  });

  it("8) shared -> espera -> api e 9) api -> espera -> web", async () => {
    const run = makeRunner();
    const order: string[] = [];
    const result = await runRollout({
      config: makeConfig(),
      run: async (command: string, args: string[] = [], opts: Record<string, unknown> = {}) => {
        const real = unwrap({ command, args });
        if (real.command === "npm" && real.args.includes("build")) order.push(real.args[2] ?? "");
        return run(command, args, opts as never);
      },
      readResources: reader([
        { load1: 0.32 },
        { load1: 0.32 },
        { load1: 0.32 },
        { load1: 3.19 },
        { load1: 1.1 },
        { load1: 3.4 },
        { load1: 0.9 },
      ]),
    });

    expect(result.ok).toBe(true);
    expect(order).toEqual([
      "--workspace=packages/shared-types",
      "--workspace=apps/api",
      "--workspace=apps/web",
    ]);
    // Houve espera antes da API e antes do web.
    expect(logs.filter((line) => line.includes("aguardando recursos")).length).toBeGreaterThanOrEqual(2);
  });

  it("10) os thresholds de produção continuam os mesmos", () => {
    const t = guard.readThresholds({});
    expect(t.memRequiredMb).toBe(1200);
    expect(t.swapUsedMaxMb).toBe(512);
    expect(t.load1Max).toBe(1.5);
    expect(t.diskFreeMinGb).toBe(2);
    expect(t.buildHeapMb).toBe(1024);
  });

  it("11) o rollback usa espera limitada (não pressiona a produção)", async () => {
    const run = makeRunner({ healthFails: true });
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: reader([{ load1: 0.32 }, { load1: 3.19 }]),
    });

    expect(result.ok).toBe(false);
    expect(result.state.rollback).toBeDefined();
    // Nenhum container de projeto foi tocado.
    for (const call of dockerCalls()) {
      expect(["ps", "inspect", "stats", "version", "info"]).toContain(call.args[0]);
    }
  });

  it("12) o rollback restaura a previousBranch e 13) o previousCommit", async () => {
    const run = makeRunner({ buildFails: true });
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: reader([{ load1: 0.32 }, { load1: 3.19 }]),
    });

    expect(result.ok).toBe(false);
    const checkout = calls.find(
      (call) => call.command === "git" && call.args.includes("checkout") && call.args.includes("main"),
    );
    expect(checkout).toBeDefined();
    const reset = calls.find((call) => call.command === "git" && call.args.includes("reset"));
    expect(reset).toBeDefined();
    expect(reset?.args[reset.args.length - 1]).toBe("c1c1c1c");
  });

  it("14) RECOVERY_DEFERRED preserva a branch (nunca detached)", async () => {
    const run = makeRunner({ buildFails: true });
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: reader([{ load1: 0.32 }, { load1: 3.19 }]),
    });

    expect(result.state.rollback?.deferred).toBe(true);
    expect(result.state.rollback?.status).toBe("RECOVERY_DEFERRED");
    expect(result.state.rollback?.git?.branch).toBe("main");
    expect(result.state.rollback?.git?.commit).toBe("c1c1c1c");
    expect(result.state.rollback?.reason).toContain("Core em execução permaneceu na versão anterior");
  });

  it("15) RECOVERY_REQUIRED não deixa o checkout em detached HEAD", async () => {
    const run = makeRunner({ healthFails: true });
    const result = await runRollout({
      config: makeConfig(),
      run,
      // Recursos OK até o restart do PM2; a pressão aparece só no rollback.
      readResources: reader([
        { load1: 0.32 },
        { load1: 0.32 },
        { load1: 0.32 },
        { load1: 0.32 },
        { load1: 0.32 },
        { load1: 3.19 },
      ]),
    });

    expect(result.state.rollback?.status).toBe("RECOVERY_REQUIRED");
    expect(result.state.rollback?.git?.branch).toBe("main");
    expect(result.state.rollback?.git?.commit).toBe("c1c1c1c");
  });

  it("16) o rollout bem-sucedido preserva a branch e vai ao commit candidato", async () => {
    const run = makeRunner();
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: reader([{ load1: 0.32 }]),
    });

    expect(result.ok).toBe(true);
    expect(result.state.finalGitState?.branch).toBe("main");
    expect(result.state.finalGitState?.commit).toBe("c2c2c2c");
    // E a verificação final roda no sucesso.
    const stages = result.stages as { id: string; status: string }[];
    expect(stages.find((stage) => stage.id === "git-verify")?.status).toBe("ok");
  });

  it("17) working tree inesperado IMPEDE o reset destrutivo", async () => {
    const run = makeRunner({ buildFails: true, dirtyDuringRecovery: ["config-do-operador.env"] });
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: reader([{ load1: 0.32 }, { load1: 3.19 }]),
    });

    expect(result.ok).toBe(false);
    // Nenhum reset --hard foi executado (os dados do operador ficam).
    expect(calls.some((call) => call.command === "git" && call.args.includes("reset"))).toBe(false);
    expect(result.state.rollback?.reason).toContain("working tree contém alterações inesperadas");
    expect(result.state.rollback?.reason).toContain("config-do-operador.env");
    expect(result.state.recoveryRequired).toBe(true);
  });

  it("18) nenhum comando Docker destrutivo em nenhum cenário", async () => {
    for (const options of [{ buildFails: true }, { healthFails: true }]) {
      const run = makeRunner(options);
      await runRollout({
        config: makeConfig(),
        run,
        readResources: reader([{ load1: 0.32 }, { load1: 3.19 }]),
      });
      for (const call of dockerCalls()) {
        expect(["rm", "rmi", "stop", "start", "restart", "kill", "update", "run", "create", "up", "down", "exec", "compose"]).not.toContain(
          call.args[0],
        );
      }
    }
  });

  it("19) o bootstrap --repo-root continua funcionando", async () => {
    const target = path.join(tmpDir, "target");
    const executor = path.join(tmpDir, "executor");
    for (const dir of [target, executor]) {
      fs.mkdirSync(path.join(dir, "apps", "api", "prisma"), { recursive: true });
      fs.writeFileSync(path.join(dir, "apps", "api", "prisma", "dev.db"), "sqlite");
      fs.writeFileSync(path.join(dir, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
    }
    const config = makeConfig({
      repoRoot: target,
      executorRoot: executor,
      targetRepoRoot: target,
      coreDbPath: path.join(target, "apps", "api", "prisma", "dev.db"),
      coreEnvPath: path.join(target, "apps", "api", ".env"),
    });

    const run = makeRunner();
    const result = await runRollout({ config, run, readResources: reader([{ load1: 0.32 }]) });

    expect(result.ok).toBe(true);
    expect(result.state.previousCommit).toBe("c1c1c1c");
    expect(result.state.candidateCommit).toBe("c2c2c2c");
    expect(result.state.previousBranch).toBe("main");
  });

  it("20) o dry-run continua com zero escrita", async () => {
    const config = makeConfig();
    const run = makeRunner();
    const result = await runRollout({
      config,
      run,
      dryRun: true,
      readResources: reader([{ load1: 0.32 }]),
    });

    expect(result.dryRun).toBe(true);
    expect(fs.existsSync(config.lockPath)).toBe(false);
    expect(fs.existsSync(config.drainFilePath)).toBe(false);
    expect(fs.existsSync(config.statusDir)).toBe(false);
    // E mostra a configuração do cooldown (sem esperar de verdade).
    expect(result.preflight.resourceWaitConfig.intervalSec).toBe(10);
    expect(result.preflight.resourceWaitConfig.timeoutSec).toBe(180);
    expect(result.preflight.resourceWaitConfig.thresholds.load1Max).toBe(1.5);
  });

  it("21) cenário real: load 3.19 -> 2.4 -> 1.3 normaliza e o rollout continua", async () => {
    const run = makeRunner();
    const result = await runRollout({
      config: makeConfig(),
      run,
      // preflight, antes do npm ci, antes do shared (3.19), 10s (2.4), 20s (1.3)
      readResources: reader([{ load1: 0.32 }, { load1: 0.32 }, { load1: 3.19 }, { load1: 2.4 }, { load1: 1.3 }]),
    });

    expect(result.ok).toBe(true);
    // O log mostra a espera e a normalização.
    expect(logs.some((line) => line.includes("aguardando recursos"))).toBe(true);
    expect(logs.some((line) => line.includes("recursos normalizados"))).toBe(true);
    // E a produção não foi tocada.
    for (const call of dockerCalls()) {
      expect(["ps", "inspect"]).toContain(call.args[0]);
    }
  });

  it("22) o cenário de timeout não toca a produção", async () => {
    const run = makeRunner();
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: reader([{ load1: 3.2 }]),
    });

    expect(result.ok).toBe(false);
    for (const call of dockerCalls()) {
      expect(["ps", "inspect"]).toContain(call.args[0]);
    }
    // E nenhum restart de PM2 (o Core antigo continua rodando).
    expect(calls.some((call) => call.command === "pm2" && call.args[0] === "restart")).toBe(false);
  });

  it("23) o PM2 antigo não é reiniciado desnecessariamente", async () => {
    const run = makeRunner({ buildFails: true });
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: reader([{ load1: 0.32 }, { load1: 3.19 }]),
    });

    expect(result.ok).toBe(false);
    expect(calls.some((call) => call.command === "pm2" && call.args[0] === "restart")).toBe(false);
  });

  it("24) as migrations continuam protegidas (backup antes da migration)", async () => {
    const run = makeRunner();
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: reader([{ load1: 0.32 }]),
    });

    expect(result.ok).toBe(true);
    const backupIndex = calls.findIndex(
      (call) => call.command === "sqlite3" && String(call.args[1]).startsWith(".backup"),
    );
    const migrationIndex = calls.findIndex((call) => call.command === "npx" && call.args[0] === "prisma");
    expect(backupIndex).toBeGreaterThanOrEqual(0);
    expect(migrationIndex).toBeGreaterThan(backupIndex);
  });

  it("25) o npm ci continua sendo o install (e npm install não aparece)", async () => {
    const run = makeRunner();
    await runRollout({ config: makeConfig(), run, readResources: reader([{ load1: 0.32 }]) });

    const installs = npmCalls().filter((call) => {
      const args = unwrap(call).args;
      return args[0] === "ci" || args[0] === "install";
    });
    expect(installs.length).toBeGreaterThan(0);
    for (const call of installs) {
      expect(unwrap(call).args[0]).toBe("ci");
    }
  });
});

export {};
