import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Dry-run REAL do rollout (Wave 2.5 - hotfix).
 *
 * O dry-run tem que ser uma VERIFICAÇÃO de verdade, somente leitura:
 * - git (branch, commit, working tree, remoto/candidato local);
 * - core (banco, sqlite acessível, DeployJob running, migrations);
 * - host (disco, memória, Docker, PM2, health da API e do web);
 * - snapshot REAL dos containers dos projetos (Mesatta, Mongo, Evolution,
 *   Postgres, Redis).
 *
 * E não pode escrever NADA: sem lock, sem drain, sem backup, sem git pull,
 * sem npm, sem migration, sem chmod, sem restart de PM2 e sem nenhum
 * comando Docker de escrita.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const LIBS = path.resolve(__dirname, "..", "..", "..", "scripts", "rollout", "lib");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rolloutLib = require(path.join(LIBS, "rollout.cjs"));

type RunResult = { code: number; stdout: string; stderr: string; timedOut?: boolean };

const MESATTA_APP = "korrelo-mesatta-8452004c";
const MESATTA_MONGO = "korrelo-mesatta-8452004c-db-1";
const EVOLUTION_APP = "korrelo-evolution-api-whatsapp-f848a858";
const EVOLUTION_PG = "korrelo-evolution-api-whatsapp-f848a858-db-1";
const EVOLUTION_REDIS = "korrelo-evolution-api-whatsapp-f848a858-db-redis-1";

const CONTAINERS = [
  { name: MESATTA_APP, id: "aaaa1111", image: "korrelo-mesatta:commit-1", mem: 1757, swap: 3514, health: "healthy", port: "3002/tcp" },
  { name: MESATTA_MONGO, id: "bbbb2222", image: "mongo:7", mem: 879, swap: 1758, health: null, port: "" },
  { name: EVOLUTION_APP, id: "cccc3333", image: "korrelo-evolution:commit-2", mem: 1757, swap: 3514, health: null, port: "3003/tcp" },
  { name: EVOLUTION_PG, id: "dddd4444", image: "postgres:16-alpine", mem: 586, swap: 1172, health: "healthy", port: "" },
  { name: EVOLUTION_REDIS, id: "eeee5555", image: "redis:7-alpine", mem: 586, swap: 1172, health: null, port: "" },
];

function inspectPayload(container: (typeof CONTAINERS)[number]) {
  return JSON.stringify({
    Name: `/${container.name}`,
    Id: container.id,
    Config: { Image: container.image },
    HostConfig: {
      Memory: container.mem * 1024 * 1024,
      MemorySwap: container.swap * 1024 * 1024,
      RestartPolicy: { Name: "unless-stopped" },
    },
    NetworkSettings: {
      Networks: { "korrelo-shared": {} },
      Ports: container.port ? { [container.port]: [{}] } : {},
    },
    Mounts: [{ Type: "volume", Name: `${container.name}-data`, Source: "/var/lib/docker/volumes/x", Destination: "/data" }],
    RestartCount: 0,
    State: {
      Status: "running",
      Running: true,
      StartedAt: "2026-10-19T10:00:00.000000000Z",
      ...(container.health ? { Health: { Status: container.health } } : {}),
    },
  });
}

describe("dry-run real do rollout (somente leitura)", () => {
  let tmpDir: string;
  let calls: { command: string; args: string[] }[];

  function makeConfig() {
    return {
      repoRoot: tmpDir,
      coreDbPath: path.join(tmpDir, "dev.db"),
      coreEnvPath: path.join(tmpDir, ".env"),
      coreBackupDir: path.join(tmpDir, "backups"),
      projects: [{ name: MESATTA_APP }, { name: EVOLUTION_APP }],
      pm2Apps: ["korrelo-api", "korrelo-web"],
      apiHealthUrl: "http://127.0.0.1:3001/health",
      webHealthUrl: "http://127.0.0.1:3000/",
      lockPath: path.join(tmpDir, "self-update.lock"),
      drainFilePath: path.join(tmpDir, "worker-drain"),
      statusDir: path.join(tmpDir, "rollouts"),
    };
  }

  function makeRunner(options: { dockerFails?: boolean; healthFails?: boolean } = {}) {
    return async (command: string, args: string[] = []): Promise<RunResult> => {
      calls.push({ command, args });

      if (command === "git") {
        if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--verify") return { code: 0, stdout: "af1205a\n", stderr: "" };
        if (args[0] === "rev-parse") return { code: 0, stdout: "af1205af4c227b07e0c2c7c99858040f6171244a\n", stderr: "" };
        if (args[0] === "remote") return { code: 0, stdout: "https://github.com/claudiojc030/Korrelo.git\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      }

      if (command === "sqlite3") {
        const sql = String(args[1] ?? "");
        if (/DeployJob/.test(sql)) return { code: 0, stdout: "0\n", stderr: "" };
        return { code: 0, stdout: "1\n", stderr: "" };
      }

      if (command === "df") return { code: 0, stdout: "Filesystem Size Used Avail Use%\n/dev/sda1 48G 20G 28G 42% /\n", stderr: "" };
      if (command === "free") return { code: 0, stdout: "Mem:  total used free\n", stderr: "" };
      if (command === "pm2") {
        return {
          code: 0,
          stdout: JSON.stringify([
            { name: "korrelo-api", pm2_env: { status: "online" } },
            { name: "korrelo-web", pm2_env: { status: "online" } },
          ]),
          stderr: "",
        };
      }
      if (command === "curl") {
        const url = String(args[args.length - 1]);
        if (options.healthFails && url.includes("3001")) return { code: 7, stdout: "", stderr: "recusado" };
        return { code: 0, stdout: "ok", stderr: "" };
      }

      if (command === "docker") {
        if (options.dockerFails) return { code: 1, stdout: "", stderr: "docker indisponível" };
        if (args[0] === "ps") {
          const filterIndex = args.indexOf("--filter");
          if (filterIndex === -1) {
            return { code: 0, stdout: `${CONTAINERS.map((c) => c.name).join("\n")}\n`, stderr: "" };
          }
          const filter = String(args[filterIndex + 1] ?? "");
          const project = filter.split("=").pop() ?? "";
          const names = CONTAINERS.filter((c) => c.name.startsWith(project)).map((c) => c.name);
          return { code: 0, stdout: `${names.join("\n")}\n`, stderr: "" };
        }
        if (args[0] === "inspect") {
          const target = String(args[3] ?? "");
          const found = CONTAINERS.find((c) => c.name === target);
          if (!found) return { code: 1, stdout: "", stderr: "not found" };
          return { code: 0, stdout: inspectPayload(found), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }

      return { code: 0, stdout: "", stderr: "" };
    };
  }

  beforeEach(() => {
    calls = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-dryrun-"));
    fs.writeFileSync(path.join(tmpDir, "dev.db"), "sqlite");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function runDryRun(options: { dockerFails?: boolean; healthFails?: boolean } = {}) {
    const result = await rolloutLib.executeRollout({
      config: makeConfig(),
      run: makeRunner(options),
      log: () => undefined,
      dryRun: true,
    });
    return result;
  }

  function commandNames(): string[] {
    return calls.map((call) => `${call.command} ${call.args[0] ?? ""}`.trim());
  }

  it("1) --plan NÃO executa Docker (só o plano teórico)", async () => {
    await rolloutLib.planRollout({ config: makeConfig(), run: makeRunner() });

    expect(calls.some((call) => call.command === "docker")).toBe(false);
  });

  it("2) dry-run executa docker ps e docker inspect", async () => {
    await runDryRun();

    const names = commandNames();
    expect(names).toContain("docker ps");
    expect(names).toContain("docker inspect");
  });

  it("3) dry-run captura o Mesatta e o Mongo", async () => {
    const result = await runDryRun();
    const mesatta = result.preflight.projects[MESATTA_APP].containers;

    expect(mesatta[MESATTA_APP].id).toBe("aaaa1111");
    expect(mesatta[MESATTA_APP].memoryLimitBytes).toBe(1757 * 1024 * 1024);
    expect(mesatta[MESATTA_APP].memorySwapBytes).toBe(3514 * 1024 * 1024);
    expect(mesatta[MESATTA_APP].restartPolicy).toBe("unless-stopped");
    expect(mesatta[MESATTA_APP].startedAt).toBe("2026-10-19T10:00:00.000000000Z");
    expect(mesatta[MESATTA_APP].restartCount).toBe(0);
    expect(mesatta[MESATTA_APP].health).toBe("healthy");
    expect(mesatta[MESATTA_APP].networks).toEqual(["korrelo-shared"]);
    expect(mesatta[MESATTA_APP].ports).toEqual(["3002/tcp"]);
    expect(mesatta[MESATTA_APP].mounts[0].name).toBe(`${MESATTA_APP}-data`);

    expect(mesatta[MESATTA_MONGO].id).toBe("bbbb2222");
    expect(mesatta[MESATTA_MONGO].memoryLimitBytes).toBe(879 * 1024 * 1024);
    expect(mesatta[MESATTA_MONGO].memorySwapBytes).toBe(1758 * 1024 * 1024);
  });

  it("4) dry-run captura Evolution, Postgres e Redis", async () => {
    const result = await runDryRun();
    const evolution = result.preflight.projects[EVOLUTION_APP].containers;

    expect(evolution[EVOLUTION_APP].id).toBe("cccc3333");
    expect(evolution[EVOLUTION_APP].memoryLimitBytes).toBe(1757 * 1024 * 1024);
    expect(evolution[EVOLUTION_PG].memoryLimitBytes).toBe(586 * 1024 * 1024);
    expect(evolution[EVOLUTION_REDIS].memoryLimitBytes).toBe(586 * 1024 * 1024);
  });

  it("5) dry-run lê o DeployJob (contagem de jobs running)", async () => {
    const result = await runDryRun();

    expect(result.preflight.core.activeDeploys).toBe(0);
    expect(calls.some((call) => call.command === "sqlite3" && String(call.args[1]).includes("DeployJob"))).toBe(true);
  });

  it("6) dry-run verifica o health da API e do web", async () => {
    const result = await runDryRun();

    expect(result.preflight.host.apiHealth).toBe(true);
    expect(result.preflight.host.webHealth).toBe(true);
    expect(
      calls.some(
        (call) => call.command === "curl" && String(call.args[call.args.length - 1]).includes("3001"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) => call.command === "curl" && String(call.args[call.args.length - 1]).includes("3000"),
      ),
    ).toBe(true);
  });

  it("7) dry-run NÃO cria lock", async () => {
    await runDryRun();
    expect(fs.existsSync(path.join(tmpDir, "self-update.lock"))).toBe(false);
  });

  it("8) dry-run NÃO cria o arquivo de drain", async () => {
    await runDryRun();
    expect(fs.existsSync(path.join(tmpDir, "worker-drain"))).toBe(false);
  });

  it("9) dry-run NÃO cria backup do banco", async () => {
    await runDryRun();
    const backupDir = path.join(tmpDir, "backups");
    expect(fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : []).toEqual([]);
  });

  it("10) dry-run NÃO executa git pull", async () => {
    await runDryRun();
    expect(calls.some((call) => call.command === "git" && call.args[0] === "pull")).toBe(false);
  });

  it("11) dry-run NÃO executa npm install/build", async () => {
    await runDryRun();
    expect(calls.some((call) => call.command === "npm")).toBe(false);
  });

  it("12) dry-run NÃO executa migration", async () => {
    await runDryRun();
    expect(calls.some((call) => call.command === "npx")).toBe(false);
  });

  it("13) dry-run NÃO executa chmod", async () => {
    await runDryRun();
    expect(calls.some((call) => call.command === "chmod")).toBe(false);
  });

  it("14) dry-run NÃO reinicia o PM2", async () => {
    await runDryRun();
    const pm2Calls = calls.filter((call) => call.command === "pm2");
    expect(pm2Calls.length).toBeGreaterThan(0);
    for (const call of pm2Calls) {
      expect(["jlist", "status", "describe", "pid"]).toContain(call.args[0]);
    }
  });

  it("15) dry-run NÃO executa nenhum comando Docker de escrita", async () => {
    await runDryRun();
    const dockerCalls = calls.filter((call) => call.command === "docker");
    expect(dockerCalls.length).toBeGreaterThan(0);
    for (const call of dockerCalls) {
      expect(["ps", "inspect", "stats", "version", "info"]).toContain(call.args[0]);
    }
  });

  it("16) o webHealthUrl padrão é 127.0.0.1:3000", () => {
    const config = rolloutLib.defaultConfig(tmpDir);
    expect(config.webHealthUrl).toBe("http://127.0.0.1:3000/");
    expect(config.webHealthUrl).toContain("127.0.0.1");
  });

  it("17) falha de leitura é reportada claramente (sem escrever nada)", async () => {
    const result = await runDryRun({ dockerFails: true, healthFails: true });

    expect(result.preflight.problems.length).toBeGreaterThan(0);
    expect(result.preflight.problems.join(" ")).toContain("Docker");
    // Continua sem escrever nada.
    expect(fs.existsSync(path.join(tmpDir, "self-update.lock"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "worker-drain"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "rollouts"))).toBe(false);
  });

  it("18) o dry-run recusa um comando de escrita se alguém tentar usar", () => {
    expect(rolloutLib.isReadOnlyCommand("docker", ["rm", "-f", "x"])).toBe(false);
    expect(rolloutLib.isReadOnlyCommand("docker", ["compose", "up"])).toBe(false);
    expect(rolloutLib.isReadOnlyCommand("git", ["pull"])).toBe(false);
    expect(rolloutLib.isReadOnlyCommand("git", ["status", "--porcelain"])).toBe(true);
    expect(rolloutLib.isReadOnlyCommand("docker", ["ps"])).toBe(true);
    expect(rolloutLib.isReadOnlyCommand("docker", ["inspect", "x"])).toBe(true);
    expect(rolloutLib.isReadOnlyCommand("sqlite3", ["db", "SELECT 1;"])).toBe(true);
    expect(rolloutLib.isReadOnlyCommand("sqlite3", ["db", "DROP TABLE DeployJob;"])).toBe(false);
  });
});
