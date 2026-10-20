/**
 * Testes da lib de rollout do Korrelo (scripts/rollout/lib).
 *
 * O que precisa ser garantido:
 * - o rollout ABORTA com working tree sujo (e nunca descarta a alteração);
 * - o rollout ABORTA se houver deploy de projeto em andamento;
 * - o backup do banco do Core acontece ANTES da migration (e a migration não
 *   roda se o backup falhar);
 * - o dry-run não altera nada;
 * - os containers de projeto não mudam (snapshot antes/depois idêntico);
 * - qualquer mudança em Container ID / StartedAt / RestartCount / memória /
 *   imagem / volume / rede é detectada como falha crítica;
 * - o rollback toca SOMENTE o Core.
 *
 * Tudo com fakes: nenhum Docker, PM2, Git ou banco real é executado.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require("node:path");

const LIBS = path.resolve(__dirname, "..", "..", "..", "scripts", "rollout", "lib");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { inspectGitState, formatDirtyTreeMessage } = require(path.join(LIBS, "git-state.cjs"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { backupCoreDatabase } = require(path.join(LIBS, "core-backup.cjs"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
// eslint-disable-next-line @typescript-eslint/no-var-requires
} = require(path.join(LIBS, "project-snapshot.cjs"));
const snapshotLib = require(path.join(LIBS, "project-snapshot.cjs"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lockLib = require(path.join(LIBS, "self-update-lock.cjs"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rolloutLib = require(path.join(LIBS, "rollout.cjs"));

import * as fs from "node:fs";
import * as os from "node:os";

type RunResult = { code: number; stdout: string; stderr: string; timedOut?: boolean };

/**
 * Runner falso: responde conforme o comando. Também registra TODAS as
 * chamadas (para provar que nada destrutivo foi executado).
 */
function createRunner(handlers: { [key: string]: (args: string[]) => RunResult | Promise<RunResult> } = {}) {
  const calls: { command: string; args: string[] }[] = [];
  const run = async (command: string, args: string[] = []): Promise<RunResult> => {
    calls.push({ command, args });
    const handler = handlers[command];
    if (!handler) return { code: 0, stdout: "", stderr: "" };
    return handler(args);
  };
  return { run, calls };
}

const CONTAINER_ID = "3f1c9a2b7d4e5f60718293a4b5c6d7e8f9012345678abcdef0123456789abcdef";

function inspectPayload(options: {
  id?: string;
  image?: string;
  startedAt?: string;
  restartCount?: number;
  memory?: number;
  memorySwap?: number;
  restartPolicy?: string;
  health?: string;
  networks?: string[];
  ports?: string[];
  mounts?: { name: string; destination: string }[];
}) {
  return JSON.stringify({
    Name: "/korrelo-mesatta-8452004c",
    Id: options.id ?? CONTAINER_ID,
    Config: { Image: options.image ?? "korrelo-mesatta-8452004c:commit-mesatta" },
    HostConfig: {
      Memory: options.memory ?? 1757 * 1024 * 1024,
      MemorySwap: options.memorySwap ?? 3514 * 1024 * 1024,
      RestartPolicy: { Name: options.restartPolicy ?? "unless-stopped" },
    },
    NetworkSettings: {
      Networks: Object.fromEntries((options.networks ?? ["korrelo-shared"]).map((n) => [n, {}])),
      Ports: Object.fromEntries((options.ports ?? ["3002/tcp"]).map((p) => [p, []])),
    },
    Mounts: (options.mounts ?? [{ name: "uploads-data", destination: "/app/uploads" }]).map((m) => ({
      Type: "volume",
      Name: m.name,
      Source: `/var/lib/docker/volumes/${m.name}/_data`,
      Destination: m.destination,
    })),
    RestartCount: options.restartCount ?? 0,
    State: {
      Status: "running",
      Running: true,
      StartedAt: options.startedAt ?? "2026-10-19T10:00:00.000000000Z",
      ...(options.health ? { Health: { Status: options.health } } : {}),
    },
  });
}

describe("rollout - working tree (git-state)", () => {
  it("classifica modificados, untracked e ignorados", async () => {
    const { run } = createRunner({
      git: (args) => {
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
        if (args[0] === "rev-parse") return { code: 0, stdout: "af1205a\n", stderr: "" };
        return {
          code: 0,
          stdout: " M package-lock.json\n?? scripts/local.sh\n!! node_modules/\n",
          stderr: "",
        };
      },
    });

    const state = await inspectGitState({ cwd: "/repo", run });

    expect(state.dirty).toBe(true);
    expect(state.trackedModified).toEqual(["package-lock.json"]);
    expect(state.untracked).toEqual(["scripts/local.sh"]);
    expect(state.ignored).toEqual(["node_modules/"]);
    expect(state.branch).toBe("main");
    expect(state.commit).toBe("af1205a");
  });

  it("a mensagem de abort é a padronizada", async () => {
    const { run } = createRunner({
      git: (args) =>
        args[0] === "status"
          ? { code: 0, stdout: " M package-lock.json\n", stderr: "" }
          : { code: 0, stdout: "main\n", stderr: "" },
    });

    const state = await inspectGitState({ cwd: "/repo", run });
    const message = formatDirtyTreeMessage(state);

    expect(message).toContain("Working tree contains local changes:");
    expect(message).toContain(" package-lock.json");
    expect(message).toContain("Update aborted. Review or stash/restore explicitly.");
  });
});

describe("rollout - backup do banco do Core", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-backup-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("usa sqlite3 .backup, valida e nomeia core-pre-update-YYYYMMDD-HHMMSS.db", async () => {
    const dbPath = path.join(tmpDir, "dev.db");
    fs.writeFileSync(dbPath, "conteudo");
    const backupDir = path.join(tmpDir, "backups");
    const { run, calls } = createRunner({
      sqlite3: (args) => {
        if (args[1] === "PRAGMA integrity_check;") return { code: 0, stdout: "ok\n", stderr: "" };
        if (args[1]?.startsWith(".backup")) {
          // Simula o .backup criando o arquivo de destino.
          const dest = /'([^']+)'/.exec(args[1])?.[1];
          if (dest) fs.writeFileSync(dest, "backup");
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    const result = await backupCoreDatabase({
      dbPath,
      backupDir,
      run,
      now: new Date("2026-10-19T12:34:56"),
    });

    expect(result.ok).toBe(true);
    expect(result.method).toBe("sqlite3 .backup");
    expect(path.basename(result.path)).toBe("core-pre-update-20261019-123456.db");
    // O backup fica FORA do diretório do banco.
    expect(path.dirname(result.path)).toBe(backupDir);
    // E usa .backup (nunca um cp).
    const backupCall = calls.find((call) => call.args[1]?.startsWith(".backup"));
    expect(backupCall).toBeDefined();
  });

  it("NÃO sobrescreve um backup anterior", async () => {
    const dbPath = path.join(tmpDir, "dev.db");
    fs.writeFileSync(dbPath, "x");
    const backupDir = path.join(tmpDir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const existing = path.join(backupDir, "core-pre-update-20261019-123456.db");
    fs.writeFileSync(existing, "antigo");

    const { run } = createRunner({
      sqlite3: (args) =>
        args[1] === "PRAGMA integrity_check;"
          ? { code: 0, stdout: "ok\n", stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
    });

    const result = await backupCoreDatabase({ dbPath, backupDir, run, now: new Date("2026-10-19T12:34:56") });

    expect(result.path).not.toBe(existing);
    expect(fs.readFileSync(existing, "utf-8")).toBe("antigo");
  });

  it("aborta (com instrução clara) se o sqlite3 não estiver disponível", async () => {
    const dbPath = path.join(tmpDir, "dev.db");
    fs.writeFileSync(dbPath, "x");
    const { run } = createRunner({ sqlite3: () => ({ code: 127, stdout: "", stderr: "not found" }) });

    const result = await backupCoreDatabase({ dbPath, backupDir: path.join(tmpDir, "b"), run });

    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("sqlite3");
  });

  it("aborta se o backup não passar no integrity_check", async () => {
    const dbPath = path.join(tmpDir, "dev.db");
    fs.writeFileSync(dbPath, "x");
    const { run } = createRunner({
      sqlite3: (args) =>
        args[1] === "PRAGMA integrity_check;"
          ? { code: 0, stdout: "database disk image is malformed\n", stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
    });

    const result = await backupCoreDatabase({ dbPath, backupDir: path.join(tmpDir, "b"), run });

    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("integridade");
  });
});

describe("rollout - snapshot dos projetos (read-only)", () => {
  const PROJECTS = [{ name: "korrelo-mesatta-8452004c" }, { name: "korrelo-evolution-api-whatsapp-f848a858" }];

  function snapshotRunner(inspectOptions: Parameters<typeof inspectPayload>[0] = {}) {
    return createRunner({
      docker: (args) => {
        if (args[0] === "ps") {
          return { code: 0, stdout: "korrelo-mesatta-8452004c\nkorrelo-mesatta-8452004c-db-1\n", stderr: "" };
        }
        return { code: 0, stdout: inspectPayload(inspectOptions), stderr: "" };
      },
    });
  }

  it("captura o snapshot com os campos comparados", async () => {
    const { run, calls } = snapshotRunner();

    const snapshot = await snapshotLib.captureProjectSnapshot({ projects: PROJECTS, run });

    const container = snapshot.projects["korrelo-mesatta-8452004c"].containers["korrelo-mesatta-8452004c"];
    expect(container.id).toBe(CONTAINER_ID);
    expect(container.image).toBe("korrelo-mesatta-8452004c:commit-mesatta");
    expect(container.memoryLimitBytes).toBe(1757 * 1024 * 1024);
    expect(container.memorySwapBytes).toBe(3514 * 1024 * 1024);
    expect(container.restartPolicy).toBe("unless-stopped");
    expect(container.restartCount).toBe(0);
    expect(container.startedAt).toBe("2026-10-19T10:00:00.000000000Z");
    expect(container.mounts[0].name).toBe("uploads-data");
    // Somente leitura no Docker.
    for (const call of calls) {
      expect(["ps", "inspect"]).toContain(call.args[0]);
    }
  });

  it("snapshots idênticos => sem divergência", async () => {
    const before = await snapshotLib.captureProjectSnapshot({ projects: PROJECTS, run: snapshotRunner().run });
    const after = await snapshotLib.captureProjectSnapshot({ projects: PROJECTS, run: snapshotRunner().run });

    const comparison = snapshotLib.compareProjectSnapshots(before, after);
    expect(comparison.ok).toBe(true);
    expect(comparison.changes).toEqual([]);
  });

  it.each([
    ["id", { id: "outro-id" }],
    ["startedAt", { startedAt: "2026-10-19T11:00:00.000000000Z" }],
    ["restartCount", { restartCount: 1 }],
    ["memoryLimitBytes", { memory: 1024 * 1024 * 1024 }],
    ["memorySwapBytes", { memorySwap: 2048 * 1024 * 1024 }],
    ["image", { image: "korrelo-mesatta-8452004c:commit-outro" }],
    ["restartPolicy", { restartPolicy: "always" }],
    ["mounts", { mounts: [{ name: "outro-volume", destination: "/app/uploads" }] }],
    ["networks", { networks: ["outra-rede"] }],
    ["ports", { ports: ["9999/tcp"] }],
  ])("mudança em %s => divergência detectada", async (field, override) => {
    const before = await snapshotLib.captureProjectSnapshot({ projects: PROJECTS, run: snapshotRunner().run });
    const after = await snapshotLib.captureProjectSnapshot({
      projects: PROJECTS,
      run: snapshotRunner(override as never).run,
    });

    const comparison = snapshotLib.compareProjectSnapshots(before, after);

    expect(comparison.ok).toBe(false);
    expect(comparison.changes.some((change: { field: string }) => change.field === field)).toBe(true);
  });

  it("container que sumiu também é divergência", async () => {
    const before = await snapshotLib.captureProjectSnapshot({ projects: PROJECTS, run: snapshotRunner().run });
    const emptyRunner = createRunner({ docker: () => ({ code: 0, stdout: "", stderr: "" }) });
    const after = await snapshotLib.captureProjectSnapshot({ projects: PROJECTS, run: emptyRunner.run });

    const comparison = snapshotLib.compareProjectSnapshots(before, after);
    expect(comparison.ok).toBe(false);
  });
});

describe("rollout - lock de self-update", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-lock-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("o segundo update é recusado", () => {
    const lockPath = path.join(tmpDir, "self-update.lock");

    const first = lockLib.acquireLock({ lockPath, pid: process.pid });
    expect(first.acquired).toBe(true);

    const second = lockLib.acquireLock({ lockPath, pid: process.pid });
    expect(second.acquired).toBe(false);
    expect(second.reason).toContain("já está em andamento");
  });

  it("lock órfão (processo morto) é recuperado", () => {
    const lockPath = path.join(tmpDir, "self-update.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, acquiredAt: Date.now() }));

    const result = lockLib.acquireLock({ lockPath, pid: process.pid });
    expect(result.acquired).toBe(true);
  });

  it("o lock guarda PID e timestamp", () => {
    const lockPath = path.join(tmpDir, "self-update.lock");
    lockLib.acquireLock({ lockPath, pid: 1234, now: 1_700_000_000_000 });

    const content = lockLib.readLock(lockPath);
    expect(content.pid).toBe(1234);
    expect(content.acquiredAt).toBe(1_700_000_000_000);
  });

  it("não conflita com o lock do worker de deploy", () => {
    // Arquivos diferentes, em diretórios diferentes.
    expect(lockLib.defaultLockPath()).toContain("self-update.lock");
    expect(lockLib.defaultLockPath()).not.toContain("deploy-worker.lock");
  });
});

describe("rollout - executor", () => {
  let tmpDir: string;
  let repoRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-rollout-"));
    repoRoot = path.join(tmpDir, "repo");
    fs.mkdirSync(path.join(repoRoot, "apps", "api", "prisma"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "apps", "api", "prisma", "dev.db"), "db");
    fs.writeFileSync(path.join(repoRoot, "apps", "api", ".env"), "JWT_SECRET=nao-logar-este-valor");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(overrides: Record<string, unknown> = {}) {
    return {
      repoRoot,
      coreDbPath: path.join(repoRoot, "apps", "api", "prisma", "dev.db"),
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

  function rolloutRunner(overrides: {
    dirty?: boolean;
    activeDeploys?: number;
    backupFails?: boolean;
    buildFails?: boolean;
    migrationFails?: boolean;
    healthFails?: boolean;
    assetsFail?: boolean;
    inspectOverride?: Record<string, unknown>;
  } = {}) {
    const calls: { command: string; args: string[] }[] = [];
    let healthAlreadyFailed = false;
    let inspectRound = 0;
    const run = async (command: string, args: string[] = []): Promise<RunResult> => {
      calls.push({ command, args });

      if (command === "git") {
        // O rollout usa `git -C <repo>` para não depender do cwd.
        const gitArgs = args[0] === "-C" ? args.slice(2) : args;
        if (gitArgs[0] === "status") {
          return {
            code: 0,
            stdout: overrides.dirty ? " M package-lock.json\n" : "",
            stderr: "",
          };
        }
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--verify") return { code: 0, stdout: "af1205a\n", stderr: "" };
        if (gitArgs[0] === "rev-parse") return { code: 0, stdout: "af1205a\n", stderr: "" };
        if (gitArgs[0] === "remote") return { code: 0, stdout: "https://github.com/claudiojc030/Korrelo.git\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      }

      if (command === "sqlite3") {
        if (args[1]?.startsWith("PRAGMA integrity_check")) {
          return overrides.backupFails ? { code: 0, stdout: "malformed\n", stderr: "" } : { code: 0, stdout: "ok\n", stderr: "" };
        }
        if (args[1]?.startsWith(".backup")) {
          const dest = /'([^']+)'/.exec(args[1])?.[1];
          if (dest) fs.writeFileSync(dest, "backup");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args[1]?.includes("DeployJob")) {
          return { code: 0, stdout: `${overrides.activeDeploys ?? 0}\n`, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }

      if (command === "docker") {
        if (args[0] === "ps" && args.includes("-a")) {
          return { code: 0, stdout: "korrelo-mesatta-8452004c\n", stderr: "" };
        }
        if (args[0] === "inspect") {
          // Rodada 0 = snapshot "antes"; rodada 1+ = snapshot "depois". Com o
          // override, simula uma divergência (container recriado/reiniciado).
          const round = inspectRound++;
          if (round >= 1 && overrides.inspectOverride) {
            return {
              code: 0,
              stdout: inspectPayload(overrides.inspectOverride as never),
              stderr: "",
            };
          }
          return { code: 0, stdout: inspectPayload({}), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }

      if (String(args[0] ?? "").includes("copy-standalone-assets.js")) {
        return overrides.assetsFail
          ? { code: 1, stdout: "", stderr: "falha ao copiar assets" }
          : { code: 0, stdout: "", stderr: "" };
      }

      if (command === "npm") {
        if (args[0] === "run" && args[1] === "build") {
          return overrides.buildFails ? { code: 1, stdout: "", stderr: "build falhou" } : { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }

      if (command === "npx") {
        return overrides.migrationFails ? { code: 1, stdout: "", stderr: "migration falhou" } : { code: 0, stdout: "", stderr: "" };
      }

      if (command === "pm2") return { code: 0, stdout: "", stderr: "" };

      if (command === "curl") {
        if (overrides.healthFails && String(args[args.length - 1]).includes("3001") && !healthAlreadyFailed) {
          // Só a PRIMEIRA checagem de health falha (simula o Core novo
          // quebrado; o rollback, com o Core antigo, responde de novo).
          healthAlreadyFailed = true;
          return { code: 7, stdout: "", stderr: "falhou" };
        }
        return { code: 0, stdout: "ok", stderr: "" };
      }

      if (command === "chmod") return { code: 0, stdout: "", stderr: "" };

      return { code: 0, stdout: "", stderr: "" };
    };
    return { run, calls };
  }

  it("1) rollout bloqueia com working tree sujo (e não descarta nada)", async () => {
    const { run, calls } = rolloutRunner({ dirty: true });
    const result = await rolloutLib.executeRollout({ config: makeConfig(), run });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Working tree contains local changes");
    expect(result.error).toContain("package-lock.json");
    // Nada de reset/checkout/stash.
    for (const call of calls) {
      if (call.command !== "git") continue;
      // "checkout" é permitido: só o rollback do Core usa (voltar ao commit anterior).
      const gitArgs = call.args[0] === "-C" ? call.args.slice(2) : call.args;
      expect(["reset", "stash", "restore", "clean"]).not.toContain(gitArgs[0]);
    }
  });

  it("2) rollout bloqueia com deploy de projeto em andamento", async () => {
    const { run } = rolloutRunner({ activeDeploys: 1 });
    const result = await rolloutLib.executeRollout({ config: makeConfig(), run });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("deploy(s) de projeto em andamento");
  });

  it("3) o backup acontece ANTES da migration", async () => {
    const { run, calls } = rolloutRunner();
    const result = await rolloutLib.executeRollout({ config: makeConfig(), run });

    expect(result.ok).toBe(true);
    const backupIndex = calls.findIndex((call) => call.command === "sqlite3" && call.args[1]?.startsWith(".backup"));
    const migrationIndex = calls.findIndex((call) => call.command === "npx" && call.args[0] === "prisma");
    expect(backupIndex).toBeGreaterThanOrEqual(0);
    expect(migrationIndex).toBeGreaterThan(backupIndex);
  });

  it("4) a migration NÃO roda se o backup falhar", async () => {
    const { run, calls } = rolloutRunner({ backupFails: true });
    const result = await rolloutLib.executeRollout({ config: makeConfig(), run });

    expect(result.ok).toBe(false);
    expect(calls.some((call) => call.command === "npx" && call.args[0] === "prisma")).toBe(false);
    // E o backup criado é informado.
    expect(result.state.backupPath).toBeTruthy();
  });

  it("8) dry-run não altera nada (nenhum comando de escrita)", async () => {
    const { run, calls } = rolloutRunner();
    const result = await rolloutLib.executeRollout({ config: makeConfig(), run, dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    // Todo comando executado no dry-run é de LEITURA (mesma allowlist que o
    // próprio lib usa para abortar comandos de escrita).
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(rolloutLib.isReadOnlyCommand(call.command, call.args)).toBe(true);
    }
    // Nenhum arquivo criado (lock/drain/status).
    expect(fs.existsSync(path.join(tmpDir, "worker-drain"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "self-update.lock"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "rollouts"))).toBe(false);
  });

  it("22) migration falhando: o PM2 NÃO é reiniciado", async () => {
    const { run, calls } = rolloutRunner({ migrationFails: true });
    const result = await rolloutLib.executeRollout({ config: makeConfig(), run });

    expect(result.ok).toBe(false);
    const pm2Calls = calls.filter((call) => call.command === "pm2" && call.args[0] === "restart");
    // Só o rollback pode reiniciar o Core (e ele é o último recurso).
    for (const call of pm2Calls) {
      expect(call.args.slice(1)).toEqual(expect.arrayContaining(["korrelo-api"]));
    }
    expect(result.state.rollback).toBeDefined();
  });

  it("23) build falhando: a migration não roda", async () => {
    const { run, calls } = rolloutRunner({ buildFails: true });
    const result = await rolloutLib.executeRollout({ config: makeConfig(), run });

    expect(result.ok).toBe(false);
    expect(calls.some((call) => call.command === "npx" && call.args[1] === "prisma")).toBe(false);
  });

  it("24) health da API falhando: o Core volta ao commit anterior", async () => {
    const { run, calls } = rolloutRunner({ healthFails: true });
    const result = await rolloutLib.executeRollout({ config: makeConfig(), run });

    expect(result.ok).toBe(false);
    expect(result.state.rollback?.ok).toBe(true);
    const checkout = calls.find(
      (call) => call.command === "git" && (call.args[0] === "checkout" || call.args[2] === "checkout"),
    );
    expect(checkout).toBeDefined();
  });

  it("25/26) o rollback reinicia SOMENTE o Core e nunca toca em projeto", async () => {
    const { run, calls } = rolloutRunner({ healthFails: true });
    await rolloutLib.executeRollout({ config: makeConfig(), run });

    const pm2Calls = calls.filter((call) => call.command === "pm2" && call.args[0] === "restart");
    expect(pm2Calls.length).toBeGreaterThan(0);
    for (const call of pm2Calls) {
      expect(call.args.slice(1)).toEqual(["korrelo-api", "korrelo-web"]);
    }
    // Nenhum comando destrutivo no Docker em nenhum momento.
    const forbidden = ["rm", "rmi", "stop", "start", "restart", "kill", "update", "run", "create", "up", "down", "exec", "compose"];
    for (const call of calls) {
      if (call.command !== "docker") continue;
      expect(forbidden).not.toContain(call.args[0]);
    }
  });

  it("29/30) .env e dev.db recebem permissão 600", async () => {
    const { run, calls } = rolloutRunner();
    await rolloutLib.executeRollout({ config: makeConfig(), run });

    const chmods = calls.filter((call) => call.command === "chmod");
    const envChmod = chmods.find((call) => call.args[1]?.endsWith(".env"));
    const dbChmod = chmods.find((call) => call.args[1]?.endsWith("dev.db"));
    expect(envChmod?.args[0]).toBe("600");
    expect(dbChmod?.args[0]).toBe("600");
  });

  it("31) o log do rollout não vaza segredo", async () => {
    const logs: string[] = [];
    const { run } = rolloutRunner();
    await rolloutLib.executeRollout({ config: makeConfig(), run, log: (line: string) => logs.push(line) });

    const joined = logs.join("\n");
    expect(joined).not.toContain("nao-logar-este-valor");
    expect(joined).not.toContain("JWT_SECRET");
  });

  it("32) o projeto permanece online: snapshot antes/depois idêntico", async () => {
    const { run } = rolloutRunner();
    const result = await rolloutLib.executeRollout({ config: makeConfig(), run });

    expect(result.ok).toBe(true);
    expect(result.comparison?.ok).toBe(true);
    expect(result.state.projectIntegrityCheck).toBe("intacto");
  });

  it("web-assets: os assets do Next standalone são preparados ANTES do pm2 restart", async () => {
    const { run, calls } = rolloutRunner();
    await rolloutLib.executeRollout({ config: makeConfig(), run });

    const assetsIndex = calls.findIndex((call) => call.args[0]?.includes("copy-standalone-assets.js"));
    const pm2Index = calls.findIndex((call) => call.command === "pm2" && call.args[0] === "restart");
    expect(assetsIndex).toBeGreaterThanOrEqual(0);
    expect(pm2Index).toBeGreaterThan(assetsIndex);
  });

  it("web-assets: falha na cópia aborta o rollout ANTES do pm2 restart", async () => {
    const { run } = rolloutRunner({ assetsFail: true });
    const result = await rolloutLib.executeRollout({ config: makeConfig(), run });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("assets do Next");
    // O stage de web-assets falhou e o de pm2-restart NUNCA rodou (o único
    // pm2 restart possível é o do rollback do Core, depois da falha).
    const stages = result.stages as { id: string; status: string }[];
    expect(stages.find((stage) => stage.id === "web-assets")?.status).toBe("failed");
    expect(stages.find((stage) => stage.id === "pm2-restart")).toBeUndefined();
  });

  it.each([
    ["Mesatta", { id: "outro-container-id" }],
    ["Mongo", { id: "outro-mongo-id" }],
    ["Evolution", { image: "korrelo-evolution:commit-novo" }],
  ])("divergência em %s = falha crítica (sem tocar no projeto)", async (_name, override) => {
    const { run, calls } = rolloutRunner({ inspectOverride: override as never });
    const result = await rolloutLib.executeRollout({ config: makeConfig(), run });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("DIVERGÊNCIA CRÍTICA");
    expect(result.state.projectIntegrityCheck).toBe("DIVERGENTE");
    // Nenhum comando destrutivo no Docker (o projeto não é tocado).
    const forbidden = ["rm", "rmi", "stop", "start", "restart", "kill", "update", "run", "create", "up", "down", "exec", "compose"];
    for (const call of calls) {
      if (call.command !== "docker") continue;
      expect(forbidden).not.toContain(call.args[0]);
    }
  });

  it("o self-update da UI usa o MESMO executor do rollout (proteção equivalente)", () => {
    const script = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "..", "..", "..", "scripts", "self-update.sh"),
      "utf-8",
    );
    // O botão "Atualizar agora" delega para o executor do rollout: assim os
    // dois caminhos têm snapshot antes/depois, backup, etc.
    expect(script).toContain("scripts/rollout/rollout.cjs");
    expect(script).toContain("--apply");
    // E o executor tem os stages de snapshot E de comparação.
    const stageIds = rolloutLib.STAGES.map((stage: { id: string }) => stage.id);
    expect(stageIds).toContain("snapshot-before");
    expect(stageIds).toContain("snapshot-after");
    expect(stageIds).toContain("compare-projects");
    expect(stageIds).toContain("web-assets");
  });

  it("o self-update do Core não invoca docker compose de projeto", () => {
    const script = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "..", "..", "..", "scripts", "self-update.sh"),
      "utf-8",
    );
    expect(script).not.toContain("docker compose");
    expect(script).not.toContain("docker rm");
    expect(script).not.toContain("docker restart");
    expect(script).not.toContain("docker stop");
  });

  it("5) o PM2 da API tem kill_timeout de 30s", () => {
    const ecosystem = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "..", "..", "..", "ecosystem.config.js"),
      "utf-8",
    );
    expect(ecosystem).toContain("kill_timeout: 30000");
  });
});
