/**
 * GUARDA DE RECURSOS do rollout (hotfix de hardening).
 *
 * O rollout roda `npm install` e três builds na MESMA VPS que hospeda os
 * projetos de produção (Mesatta, Mongo, Evolution API, Postgres, Redis).
 * Já houve incidente de forte pressão do host durante build.
 *
 * O que precisa ser garantido:
 * - recursos insuficientes ABORTAM o rollout antes de qualquer install/build;
 * - a pressão que surge no meio do caminho impede o próximo build;
 * - swap livre NÃO substitui RAM disponível;
 * - nada é parado, reduzido ou reiniciado para liberar recurso;
 * - os builds rodam com prioridade baixa e heap limitado (só nos processos
 *   do rollout);
 * - os builds continuam estritamente sequenciais;
 * - os projetos de produção nunca são tocados;
 * - o dry-run continua somente leitura e mostra a checagem de recursos.
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

import { safeResourceProvider } from "./testing/resource-fixtures";

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

describe("rollout - guarda de recursos do host (protege a produção durante o build)", () => {
  let tmpDir: string;
  let calls: Call[];
  let envBackup: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-resources-"));
    calls = [];
    envBackup = {
      mem: process.env.KORRELO_ROLLOUT_MEM_REQUIRED_MB,
      swap: process.env.KORRELO_ROLLOUT_SWAP_USED_MAX_MB,
      load: process.env.KORRELO_ROLLOUT_LOAD1_MAX,
      disk: process.env.KORRELO_ROLLOUT_DISK_FREE_GB_MIN,
      heap: process.env.KORRELO_ROLLOUT_BUILD_HEAP_MB,
    };
    for (const key of Object.keys(envBackup)) delete process.env[`KORRELO_ROLLOUT_${key.toUpperCase()}_MB`];
    delete process.env.KORRELO_ROLLOUT_MEM_REQUIRED_MB;
    delete process.env.KORRELO_ROLLOUT_SWAP_USED_MAX_MB;
    delete process.env.KORRELO_ROLLOUT_LOAD1_MAX;
    delete process.env.KORRELO_ROLLOUT_DISK_FREE_GB_MIN;
    delete process.env.KORRELO_ROLLOUT_BUILD_HEAP_MB;
  });

  afterEach(() => {
    for (const key of Object.keys(envBackup)) {
      const value = envBackup[key];
      if (value === undefined) delete process.env[`KORRELO_ROLLOUT_${key.toUpperCase()}_MB`];
    }
    delete process.env.KORRELO_ROLLOUT_MEM_REQUIRED_MB;
    delete process.env.KORRELO_ROLLOUT_SWAP_USED_MAX_MB;
    delete process.env.KORRELO_ROLLOUT_LOAD1_MAX;
    delete process.env.KORRELO_ROLLOUT_DISK_FREE_GB_MIN;
    delete process.env.KORRELO_ROLLOUT_BUILD_HEAP_MB;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(overrides: Record<string, unknown> = {}) {
    const repoRoot = path.join(tmpDir, "repo");
    const coreDbPath = path.join(repoRoot, "apps", "api", "prisma", "dev.db");
    fs.mkdirSync(path.dirname(coreDbPath), { recursive: true });
    fs.writeFileSync(coreDbPath, "sqlite");
    fs.writeFileSync(path.join(repoRoot, "apps", "api", ".env"), "JWT_SECRET=x");
    // O rollout usa `npm ci`: sem lockfile, ele aborta.
    fs.writeFileSync(path.join(repoRoot, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
    return {
      repoRoot,
      executorRoot: repoRoot,
      targetRepoRoot: repoRoot,
      coreDbPath,
      coreEnvPath: path.join(repoRoot, "apps", "api", ".env"),
      coreBackupDir: path.join(tmpDir, "backups"),
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

  /** Runner falso: git/sqlite/docker/curl/etc. e probes de nice/ionice. */
  function makeRunner(options: { nice?: boolean; ionice?: boolean; healthFails?: boolean } = {}) {
    let healthAlreadyFailed = false;
    return async (
      command: string,
      args: string[] = [],
      opts: { cwd?: string; env?: Record<string, string> } = {},
    ): Promise<RunResult> => {
      calls.push({ command, args, cwd: opts.cwd, env: opts.env });

      if (command === "nice") {
        return options.nice === false
          ? { code: 127, stdout: "", stderr: "nice: not found" }
          : { code: 0, stdout: "nice (GNU coreutils) 8.32", stderr: "" };
      }
      if (command === "ionice") {
        return options.ionice === false
          ? { code: 127, stdout: "", stderr: "ionice: not found" }
          : { code: 0, stdout: "", stderr: "" };
      }

      if (command === "git") {
        const gitArgs = args[0] === "-C" ? args.slice(2) : args;
        if (gitArgs[0] === "status") return { code: 0, stdout: "", stderr: "" };
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--is-inside-work-tree") return { code: 0, stdout: "true\n", stderr: "" };
        if (gitArgs[0] === "branch" && gitArgs[1] === "--show-current") return { code: 0, stdout: "main\n", stderr: "" };
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--verify") return { code: 0, stdout: "c2c2c2c\n", stderr: "" };
        if (gitArgs[0] === "rev-parse") return { code: 0, stdout: "c1c1c1c\n", stderr: "" };
        if (gitArgs[0] === "remote") return { code: 0, stdout: "https://github.com/claudiojc030/Korrelo.git\n", stderr: "" };
        if (gitArgs[0] === "ls-tree") {
          // Só ÁRVORES são migrations: o `migration_lock.toml` é um arquivo.
          return {
            code: 0,
            stdout: [
              "040000 tree 1111111111111111111111111111111111111111\tapps/api/prisma/migrations/20261019120000_add_deploy_jobs",
              "040000 tree 2222222222222222222222222222222222222222\tapps/api/prisma/migrations/20261019130000_add_grandfathering",
              "100644 blob 3333333333333333333333333333333333333333\tapps/api/prisma/migrations/migration_lock.toml",
              "",
            ].join("\n"),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      }

      if (command === "sqlite3") {
        const sql = String(args[1] ?? "");
        if (sql.startsWith(".backup")) {
          const dest = /'([^']+)'/.exec(sql)?.[1];
          if (dest) fs.writeFileSync(dest, "backup");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (sql.startsWith("PRAGMA integrity_check")) return { code: 0, stdout: "ok\n", stderr: "" };
        if (sql.includes("DeployJob")) return { code: 0, stdout: "0\n", stderr: "" };
        return { code: 0, stdout: "1\n", stderr: "" };
      }

      if (command === "docker") {
        if (args[0] === "ps") return { code: 0, stdout: "korrelo-mesatta-8452004c\n", stderr: "" };
        if (args[0] === "inspect") {
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

      if (command === "curl") {
        const url = String(args[args.length - 1] ?? "");
        if (options.healthFails && url.includes("3001") && !healthAlreadyFailed) {
          healthAlreadyFailed = true;
          return { code: 7, stdout: "", stderr: "falhou" };
        }
        return { code: 0, stdout: "ok", stderr: "" };
      }

      return { code: 0, stdout: "", stderr: "" };
    };
  }

  /** Sequência de leituras de recursos falsa (a sequência define quando a pressão aparece). */
  function makeResourceReader(sequence: Record<string, unknown>[]) {
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

  /** Rollout de teste: cooldown curto e sleep instantâneo. */
  function runRollout(options: Record<string, unknown>) {
    return rolloutLib.executeRollout({ sleep: instantSleep, waitConfig: TEST_WAIT, ...options });
  }

  /** Desembrulha nice/ionice: devolve o comando real e seus argumentos. */
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

  /** Chamadas de install/build (NÃO inclui as probes de nice/ionice). */
  function npmCalls() {
    return calls.filter((call) => unwrap(call).command === "npm");
  }

  function realCommandOf(call: Call): string {
    return unwrap(call).command;
  }

  function realArgsOf(call: Call): string[] {
    return unwrap(call).args;
  }

  it("1) RAM suficiente: o rollout roda até o fim", async () => {
    const run = makeRunner();
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: makeResourceReader([OK_RESOURCES]),
    });

    expect(result.ok).toBe(true);
    expect(result.state.resourceCheck?.safeToBuild).toBe(true);
    expect(npmCalls().length).toBeGreaterThanOrEqual(4);
  });

  it("2) RAM insuficiente: aborta ANTES do npm install (nenhum build começa)", async () => {
    const run = makeRunner();
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: makeResourceReader([{ memAvailableMb: 400 }]),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Rollout adiado");
    expect(result.error).toContain("recursos insuficientes");
    expect(result.error).toContain("Os projetos em produção não foram tocados");
    // Nenhum install/build.
    expect(npmCalls()).toHaveLength(0);
    // E nada foi atualizado no Git (abortou antes do git update).
    expect(result.state.rollback?.skipped).toBe(true);
  });

  it("3) pressão antes do build-api: o build da API não começa", async () => {
    const run = makeRunner();
    // Leituras: preflight, install, build-shared (ok) e build-api (pressão).
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: makeResourceReader([
        OK_RESOURCES,
        OK_RESOURCES,
        OK_RESOURCES,
        { memAvailableMb: 300 },
      ]),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Rollout adiado");
    // O build da shared-types rodou; o da API NÃO começou.
    const stages = result.stages as { id: string; status: string }[];
    expect(stages.find((stage) => stage.id === "build-shared")?.status).toBe("ok");
    expect(stages.find((stage) => stage.id === "build-api")?.status).not.toBe("ok");
  });

  it("4) pressão antes do build-web: o build do web não começa", async () => {
    const run = makeRunner();
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: makeResourceReader([
        OK_RESOURCES,
        OK_RESOURCES,
        OK_RESOURCES,
        OK_RESOURCES,
        { memAvailableMb: 300 },
      ]),
    });

    expect(result.ok).toBe(false);
    const stages = result.stages as { id: string; status: string }[];
    expect(stages.find((stage) => stage.id === "build-api")?.status).toBe("ok");
    expect(stages.find((stage) => stage.id === "build-web")?.status).not.toBe("ok");
  });

  it("5) swap acima do threshold: aborta (swap não substitui RAM)", async () => {
    const run = makeRunner();
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: makeResourceReader([{ swapUsedMb: 1500 }]),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("swap em uso");
    expect(npmCalls()).toHaveLength(0);
  });

  it("6) load alto: a política é configurável por env", async () => {
    const run = makeRunner();
    const resources = makeResourceReader([{ load1: 3.2 }]);

    // Default (1.5) bloqueia.
    const blocked = await runRollout({ config: makeConfig(), run, readResources: resources });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("load average");

    // Política relaxada por env: o mesmo load passa.
    process.env.KORRELO_ROLLOUT_LOAD1_MAX = "5";
    const run2 = makeRunner();
    const allowed = await runRollout({
      config: makeConfig(),
      run: run2,
      readResources: makeResourceReader([{ load1: 3.2 }]),
    });
    expect(allowed.ok).toBe(true);
  });

  it("7) disco baixo: aborta antes do build", async () => {
    const run = makeRunner();
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: makeResourceReader([{ diskAvailableGb: 0.4 }]),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("disco livre");
    expect(npmCalls()).toHaveLength(0);
  });

  it("8) ao abortar por recurso, a produção não é tocada", async () => {
    const run = makeRunner();
    await runRollout({
      config: makeConfig(),
      run,
      readResources: makeResourceReader([{ memAvailableMb: 200 }]),
    });

    // Nenhum comando Docker de escrita, nenhum restart de PM2.
    for (const call of calls) {
      if (call.command === "docker") {
        expect(["rm", "rmi", "stop", "start", "restart", "kill", "update", "run", "create", "up", "down", "exec", "compose"]).not.toContain(
          call.args[0],
        );
      }
      if (call.command === "pm2") {
        expect(call.args[0]).not.toBe("restart");
      }
    }
  });

  it("9) nice é usado quando existe", async () => {
    const run = makeRunner({ nice: true, ionice: false });
    await runRollout({
      config: makeConfig(),
      run,
      readResources: makeResourceReader([OK_RESOURCES]),
    });

    const builds = npmCalls().filter((call) => realArgsOf(call).includes("build"));
    expect(builds.length).toBeGreaterThan(0);
    for (const call of builds) {
      expect(call.command).toBe("nice");
      expect(call.args.slice(0, 2)).toEqual(["-n", "10"]);
      expect(realCommandOf(call)).toBe("npm");
    }
  });

  it("10) sem nice (e sem ionice) o rollout continua funcionando", async () => {
    const run = makeRunner({ nice: false, ionice: false });
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: makeResourceReader([OK_RESOURCES]),
    });

    expect(result.ok).toBe(true);
    const builds = npmCalls().filter((call) => realArgsOf(call).includes("build"));
    expect(builds.length).toBeGreaterThan(0);
    for (const call of builds) {
      expect(call.command).toBe("npm");
    }
  });

  it("11) os builds continuam estritamente sequenciais (shared -> api -> web)", async () => {
    const run = makeRunner();
    await runRollout({
      config: makeConfig(),
      run,
      readResources: makeResourceReader([OK_RESOURCES]),
    });

    const order = npmCalls().map((call) => `${realCommandOf(call)} ${realArgsOf(call).join(" ")}`.trim());
    expect(order[0]).toContain("npm ci");
    expect(order[1]).toContain("packages/shared-types");
    expect(order[2]).toContain("apps/api");
    expect(order[3]).toContain("apps/web");
    expect(order).toHaveLength(4);
  });

  it("12) o teto de heap vale SÓ para os subprocessos de install/build", async () => {
    const run = makeRunner();
    await runRollout({
      config: makeConfig(),
      run,
      readResources: makeResourceReader([OK_RESOURCES]),
    });

    const builds = npmCalls();
    expect(builds.length).toBeGreaterThan(0);
    for (const call of builds) {
      expect(call.env?.NODE_OPTIONS).toContain("--max-old-space-size=");
    }
    // O PM2 e o health NÃO recebem NODE_OPTIONS (o servidor não muda).
    for (const call of calls.filter((c) => c.command === "pm2" || c.command === "curl")) {
      expect(call.env?.NODE_OPTIONS).toBeUndefined();
    }
  });

  it("13) o dry-run mostra a checagem de recursos real", async () => {
    const run = makeRunner();
    const result = await runRollout({
      config: makeConfig(),
      run,
      dryRun: true,
      readResources: makeResourceReader([OK_RESOURCES]),
    });

    const report = result.preflight.rolloutResourceCheck;
    expect(report).toBeDefined();
    expect(report.memAvailableMb).toBe(2305);
    expect(report.memRequiredMb).toBe(1200);
    expect(report.swapUsedMb).toBe(120);
    expect(report.swapThresholdMb).toBe(512);
    expect(report.load1).toBe(0.4);
    expect(report.diskAvailableGb).toBe(12.5);
    expect(report.safeToBuild).toBe(true);
    expect(report.reason).toBeTruthy();
  });

  it("14) o dry-run continua sem nenhuma escrita", async () => {
    const config = makeConfig();
    const run = makeRunner();
    const result = await runRollout({
      config,
      run,
      dryRun: true,
      readResources: makeResourceReader([OK_RESOURCES]),
    });

    expect(result.dryRun).toBe(true);
    expect(fs.existsSync(config.lockPath)).toBe(false);
    expect(fs.existsSync(config.drainFilePath)).toBe(false);
    expect(fs.existsSync(config.statusDir)).toBe(false);
    expect(npmCalls()).toHaveLength(0);
  });

  it("15) migration_lock.toml NÃO aparece como migration", async () => {
    const run = makeRunner();
    const result = await runRollout({
      config: makeConfig(),
      run,
      dryRun: true,
      readResources: makeResourceReader([OK_RESOURCES]),
    });

    const migrations = result.preflight.core.migrationsCandidate;
    expect(migrations).toContain("20261019120000_add_deploy_jobs");
    expect(migrations).toContain("20261019130000_add_grandfathering");
    expect(migrations).not.toContain("migration_lock.toml");
    expect(migrations.some((name: string) => name.includes("migration_lock"))).toBe(false);
  });

  it("16) rollout normal com recursos suficientes continua funcionando", async () => {    const run = makeRunner();
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: makeResourceReader([OK_RESOURCES]),
    });

    expect(result.ok).toBe(true);
    expect(result.state.projectIntegrityCheck).toBe("intacto");
    expect(result.stages.some((stage: { id: string }) => stage.id === "resource-preflight")).toBe(true);
  });

  it("17) o bootstrap com --repo-root continua funcionando (build no alvo)", async () => {
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
    const result = await runRollout({
      config,
      run,
      readResources: makeResourceReader([OK_RESOURCES]),
    });

    expect(result.ok).toBe(true);
    for (const call of npmCalls()) {
      expect(call.cwd).toBe(target);
    }
  });

  it("18) o rollback continua sendo só do Core", async () => {
    const run = makeRunner({ healthFails: true });
    const result = await runRollout({
      config: makeConfig(),
      run,
      readResources: makeResourceReader([OK_RESOURCES]),
    });

    expect(result.ok).toBe(false);
    expect(result.state.rollback?.ok).toBe(true);
    const pm2Restarts = calls.filter((call) => call.command === "pm2" && call.args[0] === "restart");
    expect(pm2Restarts.length).toBeGreaterThan(0);
    for (const call of pm2Restarts) {
      expect(call.args.slice(1)).toEqual(["korrelo-api", "korrelo-web"]);
    }
    for (const call of calls) {
      if (call.command !== "docker") continue;
      expect(["rm", "rmi", "stop", "start", "restart", "kill", "update", "run", "create", "up", "down", "exec", "compose"]).not.toContain(
        call.args[0],
      );
    }
  });

  // ---------------------------------------------------- regressão do CI
  describe("regressão do CI: métricas do host real não podem decidir o teste", () => {
    it("o rollout usa o provider INJETADO, não o load real da máquina", async () => {
      // O host real está sob pressão extrema (load 10) - exatamente o que
      // quebrou a suite no GitHub Actions (load 1.52 > limite 1.5).
      const loadavg = jest.spyOn(os, "loadavg").mockReturnValue([10, 10, 10]);
      try {
        // 1) SEM provider injetado: o host real manda -> o rollout aborta.
        const blocked = await runRollout({
          config: makeConfig(),
          run: makeRunner(),
        });
        expect(blocked.ok).toBe(false);
        expect(blocked.error).toContain("load average");
        expect(blocked.error).toContain("Rollout adiado");

        // 2) COM o provider injetado (load 0.1): o rollout passa, mesmo com o
        //    host real carregado (load 10) - a medição do teste é a que vale.
        const injected = await runRollout({
          config: makeConfig(),
          run: makeRunner(),
          resourceProvider: safeResourceProvider({ load1: 0.1 }),
        });
        expect(injected.ok).toBe(true);
        expect(injected.state.resourceCheck?.safeToBuild).toBe(true);
      } finally {
        loadavg.mockRestore();
      }
    });

    it("o provider injetado com load alto aborta (o valor do teste manda)", async () => {
      const loadavg = jest.spyOn(os, "loadavg").mockReturnValue([0.1, 0.1, 0.1]);
      try {
        const blocked = await runRollout({
          config: makeConfig(),
          run: makeRunner(),
          resourceProvider: safeResourceProvider({ load1: 2.0 }),
        });
        expect(blocked.ok).toBe(false);
        expect(blocked.error).toContain("load average");
      } finally {
        loadavg.mockRestore();
      }
    });
  });

  // --------------------------------------------------------- unidade da guarda
  describe("resource-guard (unidade)", () => {    it("parse de /proc/meminfo", () => {
      const mem = guard.parseMemInfo(
        [
          "MemTotal:       3915000 kB",
          "MemFree:         300000 kB",
          "MemAvailable:   2305000 kB",
          "SwapTotal:      2047000 kB",
          "SwapFree:       1927000 kB",
          "",
        ].join("\n"),
      );
      expect(mem?.memTotalMb).toBe(3823);
      expect(mem?.memAvailableMb).toBe(2251);
      expect(mem?.swapTotalMb).toBe(1999);
      expect(mem?.swapUsedMb).toBe(117);
    });

    it("parse de df -k", () => {
      const disk = guard.parseDfOutput(
        [
          "Filesystem     1024-blocks      Used Available Capacity Mounted on",
          "/dev/sda1        41943040  20971520  20971520      50% /",
          "",
        ].join("\n"),
      );
      expect(disk?.diskAvailableGb).toBe(20);
      expect(disk?.diskTotalGb).toBe(40);
    });

    it("thresholds vêm do env com defaults conservadores", () => {
      const defaults = guard.readThresholds({});
      expect(defaults.memRequiredMb).toBe(1200);
      expect(defaults.swapUsedMaxMb).toBe(512);
      expect(defaults.load1Max).toBe(1.5);
      expect(defaults.diskFreeMinGb).toBe(2);
      expect(defaults.buildHeapMb).toBe(1024);

      const custom = guard.readThresholds({
        KORRELO_ROLLOUT_MEM_REQUIRED_MB: "2000",
        KORRELO_ROLLOUT_SWAP_USED_MAX_MB: "256",
        KORRELO_ROLLOUT_LOAD1_MAX: "3",
        KORRELO_ROLLOUT_DISK_FREE_GB_MIN: "5",
        KORRELO_ROLLOUT_BUILD_HEAP_MB: "1536",
      });
      expect(custom.memRequiredMb).toBe(2000);
      expect(custom.swapUsedMaxMb).toBe(256);
      expect(custom.load1Max).toBe(3);
      expect(custom.diskFreeMinGb).toBe(5);
      expect(custom.buildHeapMb).toBe(1536);
    });

    it("avaliação: métricas indisponíveis não bloqueiam", () => {
      const evaluation = guard.evaluateResources({
        resources: {
          memAvailableMb: null,
          swapUsedMb: null,
          load1: null,
          diskAvailableGb: null,
        },
        thresholds: guard.readThresholds({}),
      });
      expect(evaluation.safeToBuild).toBe(true);
      expect(evaluation.reason).toContain("limites");
    });

    it("avaliação: cada limite é respeitado", () => {
      const thresholds = guard.readThresholds({});
      const base = { memAvailableMb: 2000, swapUsedMb: 100, load1: 0.5, diskAvailableGb: 10 };
      expect(guard.evaluateResources({ resources: base, thresholds }).safeToBuild).toBe(true);
      expect(
        guard.evaluateResources({ resources: { ...base, memAvailableMb: 1000 }, thresholds }).safeToBuild,
      ).toBe(false);
      expect(
        guard.evaluateResources({ resources: { ...base, swapUsedMb: 900 }, thresholds }).safeToBuild,
      ).toBe(false);
      expect(guard.evaluateResources({ resources: { ...base, load1: 4 }, thresholds }).safeToBuild).toBe(false);
      expect(
        guard.evaluateResources({ resources: { ...base, diskAvailableGb: 1 }, thresholds }).safeToBuild,
      ).toBe(false);
    });

    it("wrapBuildCommand aplica nice/ionice na ordem certa", () => {
      const wrapped = guard.wrapBuildCommand({
        command: "npm",
        args: ["install"],
        nice: true,
        ionice: true,
        niceLevel: 10,
      });
      expect(wrapped.command).toBe("nice");
      expect(wrapped.args).toEqual(["-n", "10", "ionice", "-c", "3", "npm", "install"]);

      const plain = guard.wrapBuildCommand({ command: "npm", args: ["install"] });
      expect(plain.command).toBe("npm");
      expect(plain.args).toEqual(["install"]);
    });

    it("buildEnv só mexe no NODE_OPTIONS do subprocesso", () => {
      const env = guard.buildEnv({ buildHeapMb: 1024, env: {} });
      expect(env.NODE_OPTIONS).toBe("--max-old-space-size=1024");
      const withExisting = guard.buildEnv({ buildHeapMb: 512, env: { NODE_OPTIONS: "--trace-warnings" } });
      expect(withExisting.NODE_OPTIONS).toContain("--trace-warnings");
      expect(withExisting.NODE_OPTIONS).toContain("--max-old-space-size=512");
    });
  });
});

export {};
