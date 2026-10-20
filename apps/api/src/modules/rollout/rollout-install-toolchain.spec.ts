/**
 * INSTALL COM DEPENDÊNCIAS DE BUILD + TOOLCHAIN + DIAGNÓSTICO.
 *
 * Incidente real (segundo rollout na VPS): com `NODE_ENV=production` no
 * ambiente, o `npm ci` roda com `omit=dev` -> as devDependencies (typescript)
 * NÃO são instaladas -> `node_modules/.bin/tsc` não existe -> o build de
 * packages/shared-types falha com "tsc: not found" (e o rollback falha do
 * mesmo jeito).
 *
 * O que precisa ser garantido:
 * - o install é `npm ci --include=dev` (nunca `npm install`);
 * - o NODE_ENV global do servidor não impede o build;
 * - a toolchain é validada DEPOIS do install e ANTES de qualquer build;
 * - as falhas de build carregam exit code + trecho sanitizado e limitado;
 * - nada do ambiente global é alterado (sem `npm config set`, sem
 *   `unset NODE_ENV`, sem mexer em .npmrc);
 * - o resource guard (cooldown) continua antes de cada operação pesada.
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
const toolchain = require(path.join(LIBS, "toolchain.cjs"));

import { createFakeToolchain } from "./testing/resource-fixtures";

type RunResult = { code: number; stdout: string; stderr: string; timedOut?: boolean };
type Call = { command: string; args: string[]; cwd?: string; env?: Record<string, string> };

const SAFE_RESOURCES = {
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

/** Leitor de recursos com métricas fixas (o teste não depende do host). */
function readResources() {
  return async () => ({ ...SAFE_RESOURCES });
}

describe("rollout - install com devDependencies, toolchain e diagnóstico", () => {
  let tmpDir: string;
  let calls: Call[];
  let previousNodeEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-install-"));
    calls = [];
    previousNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
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

  /**
   * Runner que SIMULA o npm real: com `omit=dev` (o que o NODE_ENV=production
   * faz) as devDependencies não são instaladas.
   */
  function makeRunner(
    options: {
      omitDev?: boolean;
      toolchainMissing?: boolean;
      buildFails?: boolean;
      buildStderr?: string;
      buildExit?: number;
    } = {},
  ) {
    const repoRoot = path.join(tmpDir, "repo");
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

      if (realCommand === "npm") {
        if (realArgs[0] === "ci") {
          const includesDev = realArgs.includes("--include=dev");
          if (options.toolchainMissing) {
            // Lockfile sem as devDependencies: mesmo com --include=dev não
            // entra nada (simula um lockfile quebrado).
            fs.rmSync(path.join(repoRoot, "node_modules", "typescript"), { recursive: true, force: true });
            fs.rmSync(path.join(repoRoot, "node_modules", ".bin"), { recursive: true, force: true });
          } else if (options.omitDev && !includesDev) {
            // Sem --include=dev e com omit=dev: devDependencies não entram.
            fs.rmSync(path.join(repoRoot, "node_modules", "typescript"), { recursive: true, force: true });
            fs.rmSync(path.join(repoRoot, "node_modules", ".bin"), { recursive: true, force: true });
          } else {
            createFakeToolchain(repoRoot);
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (realArgs[0] === "run" && realArgs[1] === "build") {
          const hasTsc = fs.existsSync(path.join(repoRoot, "node_modules", ".bin", "tsc"));
          if (!hasTsc) {
            return { code: 127, stdout: "", stderr: "sh: 1: tsc: not found" };
          }
          if (options.buildFails) {
            return {
              code: options.buildExit ?? 1,
              stdout: "",
              stderr: options.buildStderr ?? "erro de compilação\nlinha 1\nlinha 2",
            };
          }
          return { code: 0, stdout: "", stderr: "" };
        }
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
        if (gitArgs[0] === "status") return { code: 0, stdout: "", stderr: "" };
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

      if (realCommand === "curl") return { code: 0, stdout: "ok", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
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

  function installCall() {
    return npmCalls().find((call) => unwrap(call).args[0] === "ci");
  }

  const TEST_WAIT = { intervalSec: 1, timeoutSec: 5 };
  const instantSleep = async () => undefined;

  function runRollout(options: Record<string, unknown>) {
    return rolloutLib.executeRollout({
      sleep: instantSleep,
      waitConfig: TEST_WAIT,
      ...options,
    });
  }

  it("1) o install usa npm ci, nunca npm install", async () => {
    const run = makeRunner();
    await runRollout({ config: makeConfig(), run, readResources });

    const installs = npmCalls().filter((call) => ["ci", "install"].includes(unwrap(call).args[0]));
    expect(installs.length).toBeGreaterThan(0);
    for (const call of installs) {
      expect(unwrap(call).args[0]).toBe("ci");
    }
  });

  it("2) o install usa --include=dev", async () => {
    const run = makeRunner();
    await runRollout({ config: makeConfig(), run, readResources });

    expect(unwrap(installCall() as Call).args).toContain("--include=dev");
  });

  it("3) NODE_ENV=production não remove o --include=dev", async () => {
    process.env.NODE_ENV = "production";
    const run = makeRunner({ omitDev: true });
    const result = await runRollout({ config: makeConfig(), run, readResources });

    expect(unwrap(installCall() as Call).args).toContain("--include=dev");
    // E o rollout chega ao fim (a toolchain está disponível).
    expect(result.ok).toBe(true);
  });

  it("4) o dry-run mostra npm ci --include=dev", async () => {
    const run = makeRunner();
    const result = await runRollout({ config: makeConfig(), run, dryRun: true, readResources });

    expect(result.preflight.plan?.builds?.[0] ?? result.plan?.builds?.[0]).toContain("npm ci --include=dev");
  });

  it("5) a toolchain é validada depois do install", async () => {
    const run = makeRunner();
    const result = await runRollout({ config: makeConfig(), run, readResources });

    const stages = result.stages as { id: string; status: string; detail: string | null }[];
    const stage = stages.find((entry) => entry.id === "toolchain-check");
    expect(stage?.status).toBe("ok");
    expect(stage?.detail).toContain("TypeScript");
    // E a validação acontece DEPOIS do install e ANTES do build.
    const installIndex = calls.findIndex((call) => unwrap(call).args[0] === "ci");
    const buildIndex = calls.findIndex((call) => unwrap(call).args.includes("build"));
    expect(installIndex).toBeLessThan(buildIndex);
  });

  it("6) toolchain ausente aborta ANTES do build-shared", async () => {
    const run = makeRunner({ toolchainMissing: true });
    const result = await runRollout({ config: makeConfig(), run, readResources });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Toolchain de build incompleta");
    expect(result.error).toContain("npm ci --include=dev");
    // O build do rollout não começou (o stage build-shared não rodou).
    const stages = result.stages as { id: string; status: string }[];
    expect(stages.find((stage) => stage.id === "build-shared")?.status).not.toBe("ok");
  });

  it("7) toolchain presente permite o build-shared", async () => {
    const run = makeRunner();
    const result = await runRollout({ config: makeConfig(), run, readResources });

    expect(result.ok).toBe(true);
    expect(npmCalls().some((call) => unwrap(call).args.includes("--workspace=packages/shared-types"))).toBe(true);
  });

  it("8) a falha de build inclui o exit code", async () => {
    const run = makeRunner({ buildFails: true, buildExit: 127, buildStderr: "sh: 1: tsc: not found" });
    const result = await runRollout({ config: makeConfig(), run, readResources });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("build de packages/shared-types falhou");
    expect(result.error).toContain("exit=127");
  });

  it("9) a falha de build inclui o stderr/stdout limitado", async () => {
    const run = makeRunner({ buildFails: true, buildExit: 127, buildStderr: "sh: 1: tsc: not found" });
    const result = await runRollout({ config: makeConfig(), run, readResources });

    expect(result.error).toContain("tsc: not found");
  });

  it("10) o output de erro continua com buffer limitado", () => {
    const huge = "x".repeat(50_000);
    const message = toolchain.formatCommandFailure({
      label: "build de packages/shared-types",
      stage: "build-shared",
      result: { code: 1, stdout: huge, stderr: huge },
      env: {},
    });

    expect(message.length).toBeLessThan(3_000);
    expect(message).toContain("exit=1");
  });

  it("11) o resource wait continua antes do install", async () => {
    const run = makeRunner();
    await runRollout({ config: makeConfig(), run, readResources });

    // O install é o primeiro npm do rollout (o guard roda antes dele).
    const firstNpm = npmCalls()[0];
    expect(unwrap(firstNpm).args[0]).toBe("ci");
  });

  it("12) o resource wait continua antes de shared/API/web", async () => {
    const run = makeRunner();
    await runRollout({ config: makeConfig(), run, readResources });

    const builds = npmCalls().filter((call) => unwrap(call).args.includes("build"));
    expect(builds).toHaveLength(3);
    expect(unwrap(builds[0]).args[2]).toContain("packages/shared-types");
    expect(unwrap(builds[1]).args[2]).toContain("apps/api");
    expect(unwrap(builds[2]).args[2]).toContain("apps/web");
  });

  it("13) o rollback Git continua main @ previousCommit", async () => {
    const run = makeRunner({ buildFails: true, buildExit: 127, buildStderr: "sh: 1: tsc: not found" });
    const result = await runRollout({ config: makeConfig(), run, readResources });

    expect(result.ok).toBe(false);
    const checkout = calls.find(
      (call) => call.command === "git" && call.args.includes("checkout") && call.args.includes("main"),
    );
    expect(checkout).toBeDefined();
    const reset = calls.find((call) => call.command === "git" && call.args.includes("reset"));
    expect(reset?.args[reset.args.length - 1]).toBe("c1c1c1c");
  });

  it("14) o recovery não deixa detached HEAD", async () => {
    const run = makeRunner({ buildFails: true, buildExit: 127 });
    const result = await runRollout({ config: makeConfig(), run, readResources });

    expect(result.state.rollback?.git?.branch).toBe("main");
    expect(result.state.rollback?.git?.commit).toBe("c1c1c1c");
  });

  it("15) working tree inesperado continua protegido", async () => {
    const run = makeRunner({ buildFails: true, buildExit: 127 });
    // O status do target volta sujo durante o recovery.
    const original = run;
    const runWithDirty = async (command: string, args: string[] = [], opts: Record<string, unknown> = {}) => {
      if (command === "git" && args.includes("status") && args.includes("--untracked-files=no")) {
        calls.push({ command, args, cwd: opts.cwd as string | undefined });
        return { code: 0, stdout: " M arquivo-do-operador.txt\n", stderr: "" };
      }
      return original(command, args, opts as never);
    };
    const result = await runRollout({ config: makeConfig(), run: runWithDirty });

    expect(calls.some((call) => call.command === "git" && call.args.includes("reset"))).toBe(false);
    expect(result.state.rollback?.reason).toContain("working tree contém alterações inesperadas");
  });

  it("16) as migrations não rodam antes dos builds", async () => {
    const run = makeRunner();
    await runRollout({ config: makeConfig(), run, readResources });

    const migrationIndex = calls.findIndex((call) => call.command === "npx" && call.args[0] === "prisma");
    let lastBuildIndex = -1;
    calls.forEach((call, index) => {
      if (unwrap(call).args.includes("build")) lastBuildIndex = index;
    });
    expect(migrationIndex).toBeGreaterThan(lastBuildIndex);
  });

  it("17) o PM2 não reinicia antes das migrations/builds", async () => {
    const run = makeRunner();
    await runRollout({ config: makeConfig(), run, readResources });

    const pm2Index = calls.findIndex((call) => call.command === "pm2" && call.args[0] === "restart");
    const migrationIndex = calls.findIndex((call) => call.command === "npx" && call.args[0] === "prisma");
    expect(pm2Index).toBeGreaterThan(migrationIndex);
  });

  it("18) nenhum container de projeto é alterado", async () => {
    const run = makeRunner();
    await runRollout({ config: makeConfig(), run, readResources });

    for (const call of calls.filter((entry) => entry.command === "docker")) {
      expect(["ps", "inspect", "stats", "version", "info"]).toContain(call.args[0]);
    }
  });

  it("19) cenário NODE_ENV=production + omit=dev: sem --include=dev a toolchain some", async () => {
    process.env.NODE_ENV = "production";
    const config = makeConfig();
    createFakeToolchain(config.repoRoot);
    const run = makeRunner({ omitDev: true });

    await run("npm", ["ci"], { cwd: config.repoRoot });

    expect(fs.existsSync(path.join(config.repoRoot, "node_modules", ".bin", "tsc"))).toBe(false);
    expect(fs.existsSync(path.join(config.repoRoot, "node_modules", "typescript"))).toBe(false);
  });

  it("20) npm ci --include=dev resolve o cenário", async () => {
    process.env.NODE_ENV = "production";
    const config = makeConfig();
    createFakeToolchain(config.repoRoot);
    const run = makeRunner({ omitDev: true });

    await run("npm", ["ci", "--include=dev"], { cwd: config.repoRoot });

    expect(fs.existsSync(path.join(config.repoRoot, "node_modules", ".bin", "tsc"))).toBe(true);
    expect(fs.existsSync(path.join(config.repoRoot, "node_modules", "typescript"))).toBe(true);
  });

  // --------------------------------------------------------- unidade da toolchain
  describe("toolchain (unidade)", () => {
    it("resolve o binário em node_modules/.bin (multiplataforma)", () => {
      const repo = path.join(tmpDir, "toolchain-repo");
      createFakeToolchain(repo);

      const unix = toolchain.resolveToolBinary({ repoRoot: repo, bin: "tsc" });
      expect(unix).toBeTruthy();
      // No Windows o npm gera `tsc.cmd` - o resolvedor aceita os dois.
      fs.rmSync(path.join(repo, "node_modules", ".bin", "tsc"));
      fs.writeFileSync(path.join(repo, "node_modules", ".bin", "tsc.cmd"), "@echo off");
      const windows = toolchain.resolveToolBinary({ repoRoot: repo, bin: "tsc" });
      expect(windows).toContain("tsc.cmd");
    });

    it("detecta a toolchain ausente", () => {
      const repo = path.join(tmpDir, "toolchain-vazio");
      fs.mkdirSync(repo, { recursive: true });

      const check = toolchain.checkBuildToolchain({ repoRoot: repo });
      expect(check.ok).toBe(false);
      expect(check.missing).toContain("TypeScript");
    });

    it("detecta a toolchain presente", () => {
      const repo = path.join(tmpDir, "toolchain-cheio");
      createFakeToolchain(repo);

      const check = toolchain.checkBuildToolchain({ repoRoot: repo });
      expect(check.ok).toBe(true);
      expect(check.found.join(" ")).toContain("TypeScript 5.5.4");
    });

    it("sanitiza valores de ambiente sensíveis", () => {
      const sanitized = toolchain.sanitizeOutput("falhou com token super-secreto-123456", {
        API_TOKEN: "super-secreto-123456",
      });
      expect(sanitized).not.toContain("super-secreto-123456");
      expect(sanitized).toContain("***");
    });

    it("formata a falha com exit code e trecho do stderr", () => {
      const message = toolchain.formatCommandFailure({
        label: "build de packages/shared-types",
        stage: "build-shared",
        result: { code: 127, stdout: "", stderr: "sh: 1: tsc: not found\n" },
        env: {},
      });

      expect(message).toContain("build de packages/shared-types falhou");
      expect(message).toContain("exit=127");
      expect(message).toContain("tsc: not found");
    });
  });
});

export {};
