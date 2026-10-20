/**
 * Bootstrap do PRIMEIRO rollout: o executor NOVO (worktree detached) atualiza
 * o checkout REAL (antigo, em produção).
 *
 * Regressão do incidente real:
 *   node rollout.cjs --repo-root /home/korrelo/korrelo --apply
 *   → o argumento era IGNORADO silenciosamente e o rollout rodou contra o
 *     próprio worktree do executor (branch=HEAD, commit=ff06a6e), falhando
 *     no `git pull` com "You are not currently on a branch.".
 *
 * Aqui o cenário é reproduzido DE VERDADE, com dois repositórios temporários
 * e Git de verdade (npm, pm2, docker, sqlite e curl são fakes).
 *
 * O que precisa ser garantido:
 * - o alvo (checkout em produção) é quem é atualizado;
 * - o executor (worktree detached) NÃO é atualizado nem recebe pull;
 * - previousCommit = HEAD do ALVO (não o commit do executor);
 * - candidateCommit = origin/main do ALVO;
 * - fast-forward é obrigatório (sem reset, sem merge);
 * - rollback volta o ALVO ao previousCommit;
 * - o banco do Core usado é o do ALVO;
 * - a config dos projetos vem do EXECUTOR;
 * - argumento desconhecido ABORTA (nunca é ignorado);
 * - --repo-root sem valor / inexistente / não-Git abortam sem escrever nada;
 * - o dry-run continua somente leitura.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const os = require("node:os");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execFileSync, spawnSync } = require("node:child_process");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const LIBS = path.resolve(__dirname, "..", "..", "..", "scripts", "rollout", "lib");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rolloutLib = require(path.join(LIBS, "rollout.cjs"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cliArgs = require(path.join(LIBS, "cli-args.cjs"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { run: realRun } = require(path.join(LIBS, "command-runner.cjs"));

import { safeResourceProvider, createFakeToolchain } from "./testing/resource-fixtures";

const CLI_PATH = path.resolve(__dirname, "..", "..", "..", "scripts", "rollout", "rollout.cjs");
const WRAPPER_PATH = path.resolve(__dirname, "..", "..", "..", "..", "..", "scripts", "rollout-korrelo.sh");

type RunResult = { code: number; stdout: string; stderr: string; timedOut?: boolean };
type Call = { command: string; args: string[]; cwd?: string };

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Korrelo Teste",
  GIT_AUTHOR_EMAIL: "teste@korrelo.local",
  GIT_COMMITTER_NAME: "Korrelo Teste",
  GIT_COMMITTER_EMAIL: "teste@korrelo.local",
  GIT_CONFIG_GLOBAL: "NUL",
  GIT_CONFIG_SYSTEM: "NUL",
};

/** Roda um comando git de verdade e devolve a saída. */
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });
}

/** Caminho do alvo de um comando git ("-C <path>" ou o cwd). */
function gitTarget(call: Call): string | undefined {
  if (call.command !== "git") return undefined;
  if (call.args[0] === "-C") return call.args[1];
  return call.cwd;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe("rollout - bootstrap do primeiro rollout (executor externo -> alvo real)", () => {
  let tmpDir: string;

  /**
   * Todo rollout de teste roda com métricas de recurso FIXAS: o resultado
   * nunca pode depender do load/RAM/disco da máquina (nem do runner do CI).
   * O cooldown também é curto e sem dormir de verdade.
   */
  function runRollout(options: Record<string, unknown>) {
    return rolloutLib.executeRollout({
      resourceProvider: safeResourceProvider(),
      sleep: async () => undefined,
      waitConfig: { intervalSec: 1, timeoutSec: 2 },
      // Janela de health curta: o teste não espera 60s pelo Core subir.
      healthConfig: { timeoutSec: 2, intervalSec: 1, initialDelaySec: 0 },
      ...options,
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-bootstrap-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------ parsing
  describe("parsing explícito de argumentos", () => {
    it("rejeita argumento desconhecido (nunca ignora)", () => {
      for (const bogus of ["--repo-rootX", "--foobar", "--apply-now", "abc", "-x", "--plan=1"]) {
        expect(() => cliArgs.parseArgs([bogus])).toThrow(/argumento inválido/);
      }
    });

    it("rejeita --repo-root sem valor", () => {
      expect(() => cliArgs.parseArgs(["--repo-root"])).toThrow("--repo-root requer um caminho");
      expect(() => cliArgs.parseArgs(["--repo-root", "--apply"])).toThrow("--repo-root requer um caminho");
      expect(() => cliArgs.parseArgs(["--repo-root="])).toThrow("--repo-root requer um caminho");
    });

    it("não combina --plan com --apply", () => {
      expect(() => cliArgs.parseArgs(["--plan", "--apply"])).toThrow(/não podem ser usados juntos/);
    });

    it("aceita apenas --plan, --apply e --repo-root <path>", () => {
      expect(cliArgs.parseArgs([])).toEqual({ mode: "dry-run", repoRoot: null });
      expect(cliArgs.parseArgs(["--plan"])).toEqual({ mode: "plan", repoRoot: null });
      expect(cliArgs.parseArgs(["--apply"])).toEqual({ mode: "apply", repoRoot: null });
      expect(cliArgs.parseArgs(["--repo-root", "/home/korrelo/korrelo"])).toEqual({
        mode: "dry-run",
        repoRoot: "/home/korrelo/korrelo",
      });
      expect(cliArgs.parseArgs(["--repo-root=/tmp/x", "--apply"])).toEqual({
        mode: "apply",
        repoRoot: "/tmp/x",
      });
    });

    it("o CLI aborta em argumento desconhecido ANTES de lock, drain e backup", () => {
      const home = path.join(tmpDir, "home");
      fs.mkdirSync(home, { recursive: true });
      const result = spawnSync(process.execPath, [CLI_PATH, "--foobar"], {
        encoding: "utf-8",
        env: { ...process.env, HOME: home, USERPROFILE: home },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("argumento inválido");
      // Nenhum lock, drain, status ou backup foi criado.
      expect(fs.existsSync(path.join(home, ".korrelo"))).toBe(false);
      expect(fs.existsSync(path.join(home, "korrelo-backups"))).toBe(false);
    });

    it("o CLI aborta em --repo-root sem valor ANTES de qualquer escrita", () => {
      const home = path.join(tmpDir, "home");
      fs.mkdirSync(home, { recursive: true });
      const result = spawnSync(process.execPath, [CLI_PATH, "--repo-root"], {
        encoding: "utf-8",
        env: { ...process.env, HOME: home, USERPROFILE: home },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("--repo-root requer um caminho");
      expect(fs.existsSync(path.join(home, ".korrelo"))).toBe(false);
    });
  });

  // ------------------------------------------------------- validação do alvo
  describe("validação do checkout alvo", () => {
    it("rejeita caminho inexistente", async () => {
      const info = await rolloutLib.inspectTargetRepo({
        targetRepoRoot: path.join(tmpDir, "nao-existe"),
        run: realRun,
      });
      expect(info.error).toContain("não existe");
      expect(info.isGit).toBe(false);
    });

    it("rejeita caminho que não é um repositório Git", async () => {
      const info = await rolloutLib.inspectTargetRepo({ targetRepoRoot: tmpDir, run: realRun });
      expect(info.error).toContain("não é um repositório Git válido");
    });

    it("aceita um WORKTREE (onde .git é ARQUIVO, não diretório)", async () => {
      const repo = path.join(tmpDir, "repo");
      fs.mkdirSync(repo, { recursive: true });
      git(["init", "-b", "main"], repo);
      writeFile(path.join(repo, "a.txt"), "a");
      git(["add", "."], repo);
      git(["commit", "-m", "a"], repo);
      const worktree = path.join(tmpDir, "worktree");
      git(["worktree", "add", "--detach", worktree], repo);

      // O `.git` do worktree é um ARQUIVO (não um diretório).
      expect(fs.statSync(path.join(worktree, ".git")).isFile()).toBe(true);

      const info = await rolloutLib.inspectTargetRepo({ targetRepoRoot: worktree, run: realRun });
      expect(info.error).toBeNull();
      expect(info.isGit).toBe(true);
      expect(info.detached).toBe(true);
      expect(info.commit).toMatch(/^[0-9a-f]{40}$/);
    });

    it("o CLI aborta com --repo-root inexistente ou não-Git, sem escrever nada", () => {
      const home = path.join(tmpDir, "home");
      fs.mkdirSync(home, { recursive: true });
      const naoGit = path.join(tmpDir, "nao-git");
      fs.mkdirSync(naoGit, { recursive: true });

      for (const target of [path.join(tmpDir, "nao-existe"), naoGit]) {
        const result = spawnSync(process.execPath, [CLI_PATH, "--repo-root", target], {
          encoding: "utf-8",
          env: { ...process.env, HOME: home, USERPROFILE: home },
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("checkout alvo inválido");
      }
      expect(fs.existsSync(path.join(home, ".korrelo"))).toBe(false);
    });
  });

  // ------------------------------------------ regressão do incidente real
  describe("regressão do incidente real (dois repositórios de verdade)", () => {
    type Repos = { origin: string; target: string; executor: string; oldSha: string; newSha: string };

    /** Cria o cenário real: origem com C1 (velho) e C2 (novo), alvo em C1, executor detached em C2. */
    function createRepos(): Repos {
      const origin = path.join(tmpDir, "origin");
      const target = path.join(tmpDir, "target");
      const executor = path.join(tmpDir, "executor");

      fs.mkdirSync(origin, { recursive: true });
      git(["init", "-b", "main"], origin);
      writeFile(path.join(origin, ".gitignore"), "node_modules/\napps/api/prisma/dev.db\napps/api/.env\n");
      writeFile(path.join(origin, "core.txt"), "v1");
      // O rollout usa `npm ci`: sem lockfile, ele aborta.
      writeFile(path.join(origin, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
      // Toolchain de build (typescript/tsc) - versionada no repositório de
      // teste para o rollout passar na validação pós-install.
      writeFile(path.join(origin, "node_modules", ".bin", "tsc"), "#!/bin/sh\nexit 0\n");
      writeFile(
        path.join(origin, "node_modules", "typescript", "package.json"),
        JSON.stringify({ name: "typescript", version: "5.5.4" }),
      );
      writeFile(
        path.join(origin, "apps", "web", "scripts", "copy-standalone-assets.js"),
        "console.log('assets ok');\n",
      );
      git(["add", "."], origin);
      git(["commit", "-m", "old (af1205a)"], origin);
      const oldSha = git(["rev-parse", "HEAD"], origin).trim();

      writeFile(path.join(origin, "core.txt"), "v2");
      git(["add", "."], origin);
      git(["commit", "-m", "new (ff06a6e)"], origin);
      const newSha = git(["rev-parse", "HEAD"], origin).trim();

      // O checkout REAL em produção: branch main no commit antigo.
      git(["clone", origin, target], tmpDir);
      git(["reset", "--hard", oldSha], target);

      // O executor NOVO: worktree detached no commit novo.
      git(["clone", origin, executor], tmpDir);
      git(["checkout", "--detach", newSha], executor);

      return { origin, target, executor, oldSha, newSha };
    }

    function makeConfig(repos: Repos) {
      const coreDbPath = path.join(repos.target, "apps", "api", "prisma", "dev.db");
      const coreEnvPath = path.join(repos.target, "apps", "api", ".env");
      fs.mkdirSync(path.dirname(coreDbPath), { recursive: true });
      fs.writeFileSync(coreDbPath, "sqlite");
      fs.writeFileSync(coreEnvPath, "JWT_SECRET=nao-logar-este-valor");
      // Toolchain de build (node_modules é ignorado pelo git, então é criada
      // no checkout de teste, como o `npm ci --include=dev` faria).
      createFakeToolchain(repos.target);
      return {
        executorRoot: repos.executor,
        targetRepoRoot: repos.target,
        repoRoot: repos.target,
        coreDbPath,
        coreEnvPath,
        coreBackupDir: path.join(tmpDir, "backups"),
        projects: [{ name: "korrelo-mesatta-8452004c" }],
        pm2Apps: ["korrelo-api", "korrelo-web"],
        apiHealthUrl: "http://127.0.0.1:3001/health",
        webHealthUrl: "http://127.0.0.1:3000/",
        lockPath: path.join(tmpDir, "self-update.lock"),
        drainFilePath: path.join(tmpDir, "worker-drain"),
        statusDir: path.join(tmpDir, "rollouts"),
      };
    }

    /** Runner híbrido: Git de verdade, o resto fake. */
    function makeRunner(calls: Call[], options: { healthFails?: boolean } = {}) {
    // Contador de restarts do PM2: o health da API falha durante a fase do
    // rollout e volta a responder na fase do rollback (2o restart).
    let pm2Restarts = 0;
      return async (command: string, args: string[] = [], opts: { cwd?: string } = {}): Promise<RunResult> => {
        calls.push({ command, args, cwd: opts.cwd });

        if (command === "git") return realRun(command, args, opts);

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
          if (args[0] === "ps") {
            return { code: 0, stdout: "korrelo-mesatta-8452004c\n", stderr: "" };
          }
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
                NetworkSettings: {
                  Networks: { "korrelo-shared": {} },
                  Ports: { "3002/tcp": [] },
                },
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
          if (options.healthFails && url.includes("3001") && pm2Restarts < 2) {
            return { code: 7, stdout: "", stderr: "falhou" };
          }
          return { code: 0, stdout: "ok", stderr: "" };
        }

        if (command === "pm2") {
          if (args[0] === "restart") pm2Restarts += 1;
          return { code: 0, stdout: "", stderr: "" };
        }

        // npm, npx, chmod, node: tudo falso.
        return { code: 0, stdout: "", stderr: "" };
      };
    }

    it("atualiza o ALVO (não o executor) e usa previousCommit/candidateCommit do alvo", async () => {
      const repos = createRepos();
      const config = makeConfig(repos);
      const calls: Call[] = [];
      const run = makeRunner(calls);

      const result = await runRollout({ config, run });

      expect(result.ok).toBe(true);

      // O alvo foi atualizado para o commit novo.
      expect(git(["rev-parse", "HEAD"], repos.target).trim()).toBe(repos.newSha);
      expect(git(["rev-parse", "--abbrev-ref", "HEAD"], repos.target).trim()).toBe("main");

      // O executor NÃO foi atualizado (continua detached no commit novo).
      expect(git(["rev-parse", "HEAD"], repos.executor).trim()).toBe(repos.newSha);
      expect(git(["rev-parse", "--abbrev-ref", "HEAD"], repos.executor).trim()).toBe("HEAD");

      // previousCommit vem do ALVO (o commit antigo em produção).
      expect(result.state.previousCommit).toBe(repos.oldSha);
      expect(result.state.targetPreviousCommit).toBe(repos.oldSha);
      expect(result.state.previousBranch).toBe("main");
      // candidateCommit vem de origin/main do ALVO.
      expect(result.state.candidateCommit).toBe(repos.newSha);
      expect(result.state.targetCandidateCommit).toBe(repos.newSha);
      // Estado registra executor e alvo (sem segredos).
      expect(result.state.executorRoot).toBe(repos.executor);
      expect(result.state.executorCommit).toBe(repos.newSha);
      expect(result.state.targetRepoRoot).toBe(repos.target);

      // NENHUM pull no executor: todo comando git de escrita aponta para o ALVO.
      const pulls = calls.filter((call) => call.command === "git" && call.args.includes("pull"));
      expect(pulls.length).toBe(1);
      expect(pulls[0].args).toEqual(["-C", repos.target, "pull", "--ff-only", "origin", "main"]);
      for (const call of calls) {
        if (call.command !== "git") continue;
        if (call.args.includes("pull") || call.args.includes("checkout")) {
          expect(gitTarget(call)).toBe(repos.target);
        }
      }

      // Install, builds, migration e chmod acontecem no ALVO.
      for (const call of calls) {
        if (call.command === "npm" || call.command === "npx") {
          expect(call.cwd).toContain(repos.target);
        }
        if (call.command === "chmod") {
          expect(call.args[1]).toContain(repos.target);
        }
      }

      // O banco do Core usado é o do ALVO (backup e chmod).
      const backups = calls.filter((call) => call.command === "sqlite3" && String(call.args[1]).startsWith(".backup"));
      expect(backups.length).toBeGreaterThan(0);
      expect(backups[0].args[0]).toBe(config.coreDbPath);
      expect(config.coreDbPath).toBe(path.join(repos.target, "apps", "api", "prisma", "dev.db"));
      expect(fs.existsSync(path.join(tmpDir, "backups"))).toBe(true);

      // O snapshot dos projetos continua lendo o Docker do host (sem escrita).
      const inspects = calls.filter((call) => call.command === "docker" && call.args[0] === "inspect");
      expect(inspects.length).toBeGreaterThan(0);
      expect(inspects[0].args).toContain("korrelo-mesatta-8452004c");
      for (const call of calls) {
        if (call.command !== "docker") continue;
        expect(["rm", "rmi", "stop", "start", "restart", "kill", "update", "run", "create", "up", "down", "exec", "compose"]).not.toContain(
          call.args[0],
        );
      }

      // O status registra executor, alvo, commit anterior e candidato.
      const statusFile = path.join(config.statusDir, "last.json");
      expect(fs.existsSync(statusFile)).toBe(true);
      const status = JSON.parse(fs.readFileSync(statusFile, "utf-8"));
      expect(status.executorRoot).toBe(repos.executor);
      expect(status.executorCommit).toBe(repos.newSha);
      expect(status.targetRepoRoot).toBe(repos.target);
      expect(status.targetPreviousCommit).toBe(repos.oldSha);
      expect(status.targetCandidateCommit).toBe(repos.newSha);
    });

    it("o rollback volta o ALVO ao previousCommit (e não mexe no executor)", async () => {
      const repos = createRepos();
      const config = makeConfig(repos);
      const calls: Call[] = [];
      const run = makeRunner(calls, { healthFails: true });

      const result = await runRollout({ config, run });

      expect(result.ok).toBe(false);
      expect(result.state.rollback?.ok).toBe(true);

      // O ALVO voltou ao commit antigo.
      expect(git(["rev-parse", "HEAD"], repos.target).trim()).toBe(repos.oldSha);
      // O executor não foi tocado.
      expect(git(["rev-parse", "HEAD"], repos.executor).trim()).toBe(repos.newSha);

      const checkout = calls.find(
        (call) => call.command === "git" && call.args.includes("checkout") && call.args.includes("main"),
      );
      expect(checkout).toBeDefined();
      // A branch local é movida de volta ao commit anterior (remoto intacto).
      const reset = calls.find((call) => call.command === "git" && call.args.includes("reset"));
      expect(reset?.args).toEqual(["-C", repos.target, "reset", "--hard", repos.oldSha]);

      // O alvo termina NA BRANCH original, no commit anterior (nunca detached).
      expect(git(["rev-parse", "--abbrev-ref", "HEAD"], repos.target).trim()).toBe("main");
      expect(git(["rev-parse", "HEAD"], repos.target).trim()).toBe(repos.oldSha);

      // O rollback reinicia SÓ o Core.
      const pm2Calls = calls.filter((call) => call.command === "pm2" && call.args[0] === "restart");
      expect(pm2Calls.length).toBeGreaterThan(0);
      for (const call of pm2Calls) {
        expect(call.args.slice(1)).toEqual(["korrelo-api", "korrelo-web"]);
      }
    });

    it("recovery adiado (recursos insuficientes) termina em main @ C1 - nunca detached", async () => {
      const repos = createRepos();
      const config = makeConfig(repos);
      const calls: Call[] = [];
      const run = makeRunner(calls);

      // Recursos: OK no preflight, mas o build_shared falha e o recovery
      // encontra o host carregado -> recuperação adiada.
      const lowResources = async () => ({
        memAvailableMb: 400,
        memTotalMb: 3915,
        swapUsedMb: 120,
        swapTotalMb: 2047,
        load1: 0.32,
        load5: 0.3,
        load15: 0.2,
        diskAvailableGb: 26.9,
        diskTotalGb: 40,
        measurable: true,
      });
      const reads: unknown[] = [];
      const readResources = async () => {
        const item = reads.length === 0 ? { ...(await lowResources()), memAvailableMb: 2305 } : await lowResources();
        reads.push(item);
        return item;
      };

      const result = await runRollout({ config, run, readResources });

      expect(result.ok).toBe(false);
      // O recovery preserva a BRANCH original e o commit anterior.
      expect(git(["rev-parse", "--abbrev-ref", "HEAD"], repos.target).trim()).toBe("main");
      expect(git(["rev-parse", "HEAD"], repos.target).trim()).toBe(repos.oldSha);
      // O executor não foi tocado.
      expect(git(["rev-parse", "HEAD"], repos.executor).trim()).toBe(repos.newSha);
    });

    it("alvo detached: aborta antes de qualquer escrita Git", async () => {      const repos = createRepos();
      git(["checkout", "--detach", repos.oldSha], repos.target);
      const config = makeConfig(repos);
      const calls: Call[] = [];
      const run = makeRunner(calls);

      const result = await runRollout({ config, run });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("detached HEAD");
      // Nenhum pull, nenhum checkout.
      expect(calls.some((call) => call.command === "git" && call.args.includes("pull"))).toBe(false);
      expect(calls.some((call) => call.command === "git" && call.args.includes("checkout"))).toBe(false);
    });

    it("candidato sem fast-forward: aborta sem reset, sem merge e sem tocar no alvo", async () => {
      const repos = createRepos();
      // Um commit órfão no origin: não é descendente do HEAD do alvo.
      git(["checkout", "--orphan", "diverged"], repos.origin);
      writeFile(path.join(repos.origin, "core.txt"), "v3");
      git(["add", "."], repos.origin);
      git(["commit", "-m", "diverged"], repos.origin);
      const diverged = git(["rev-parse", "HEAD"], repos.origin).trim();
      git(["fetch", "origin", "+diverged:refs/remotes/origin/main"], repos.target);

      const config = makeConfig(repos);
      const calls: Call[] = [];
      const run = makeRunner(calls);

      const result = await runRollout({ config, run });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("fast-forward obrigatório");
      // O alvo continua como estava.
      expect(git(["rev-parse", "HEAD"], repos.target).trim()).toBe(repos.oldSha);
      expect(git(["rev-parse", "origin/main"], repos.target).trim()).toBe(diverged);
      // Nem pull, nem reset, nem merge.
      const writes = calls.filter(
        (call) =>
          call.command === "git" &&
          (call.args.includes("pull") || call.args.includes("reset") || call.args.includes("merge")),
      );
      expect(writes).toHaveLength(0);
    });

    it("dry-run com repo-root: somente leitura e mostra o commit do ALVO", async () => {
      const repos = createRepos();
      const config = makeConfig(repos);
      const calls: Call[] = [];
      const run = makeRunner(calls);

      const result = await runRollout({ config, run, dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.preflight.target.root).toBe(repos.target);
      expect(result.preflight.target.commit).toBe(repos.oldSha);
      expect(result.preflight.target.candidateCommit).toBe(repos.newSha);
      expect(result.preflight.target.branch).toBe("main");
      expect(result.preflight.executor.root).toBe(repos.executor);
      expect(result.preflight.executor.commit).toBe(repos.newSha);
      // O banco reportado é o do alvo.
      expect(result.preflight.core.databasePath).toBe(config.coreDbPath);

      // Nada foi escrito e nada foi atualizado.
      expect(git(["rev-parse", "HEAD"], repos.target).trim()).toBe(repos.oldSha);
      expect(fs.existsSync(config.lockPath)).toBe(false);
      expect(fs.existsSync(config.drainFilePath)).toBe(false);
      expect(fs.existsSync(config.statusDir)).toBe(false);
      expect(calls.some((call) => call.command === "git" && call.args.includes("pull"))).toBe(false);
    });

    it("CLI real: --repo-root aponta para o ALVO e a config vem do EXECUTOR", () => {
      const repos = createRepos();
      const home = path.join(tmpDir, "home");
      fs.mkdirSync(home, { recursive: true });

      // O executor é o próprio repositório do Korrelo (que tem o
      // rollout.config.json novo); o alvo é o checkout antigo.
      const result = spawnSync(process.execPath, [CLI_PATH, "--repo-root", repos.target, "--plan"], {
        encoding: "utf-8",
        env: { ...process.env, HOME: home, USERPROFILE: home },
      });
      const out = `${result.stdout}${result.stderr}`;

      expect(result.status).toBe(0);
      // O plano é sobre o ALVO.
      expect(out).toContain(`checkout alvo:        ${repos.target}`);
      expect(out).toContain(`commit atual do alvo: ${repos.oldSha}`);
      expect(out).toContain(`candidato (origin/main): ${repos.newSha}`);
      expect(out).toContain("branch alvo:          main");
      // E a config dos projetos é a do EXECUTOR (o alvo não tem
      // rollout.config.json - ele está num commit antigo).
      expect(out).toContain("korrelo-mesatta-8452004c");
      expect(out).toContain("korrelo-evolution-api-whatsapp-f848a858");
      // Nada foi escrito.
      expect(fs.existsSync(path.join(home, ".korrelo"))).toBe(false);
    });
  });

  // ---------------------------------------------------- executor x alvo (lib)
  describe("executor x alvo", () => {
    function makeConfig() {
      return {
        repoRoot: path.join(tmpDir, "repo"),
        coreDbPath: path.join(tmpDir, "repo", "apps", "api", "prisma", "dev.db"),
        coreEnvPath: path.join(tmpDir, "repo", "apps", "api", ".env"),
        coreBackupDir: path.join(tmpDir, "backups"),
        projects: [],
        pm2Apps: ["korrelo-api", "korrelo-web"],
        apiHealthUrl: "http://127.0.0.1:3001/health",
        webHealthUrl: "http://127.0.0.1:3000/",
        lockPath: path.join(tmpDir, "self-update.lock"),
        drainFilePath: path.join(tmpDir, "worker-drain"),
        statusDir: path.join(tmpDir, "rollouts"),
      };
    }

    it("sem --repo-root: executor e alvo são o mesmo repositório", () => {
      const config = makeConfig();
      const roots = rolloutLib.resolveRoots(config);
      expect(roots.targetRepoRoot).toBe(path.resolve(config.repoRoot));
      expect(roots.executorRoot).toBe(path.resolve(config.repoRoot));
    });

    it("com --repo-root: o alvo e o executor são repositórios diferentes", () => {
      const config = {
        ...makeConfig(),
        executorRoot: path.join(tmpDir, "executor"),
        targetRepoRoot: path.join(tmpDir, "target"),
      };
      const roots = rolloutLib.resolveRoots(config);
      expect(roots.targetRepoRoot).toBe(path.join(tmpDir, "target"));
      expect(roots.executorRoot).toBe(path.join(tmpDir, "executor"));
    });

    it("o gitSubcommand entende as opções globais do Git (-C <path>)", () => {
      expect(rolloutLib.gitSubcommand(["-C", "/tmp/x", "pull", "--ff-only"])).toBe("pull");
      expect(rolloutLib.gitSubcommand(["-C", "/tmp/x", "rev-parse", "HEAD"])).toBe("rev-parse");
      expect(rolloutLib.gitSubcommand(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("rev-parse");
      expect(rolloutLib.gitSubcommand(["status", "--porcelain"])).toBe("status");
    });

    it("a allowlist aceita leitura com -C e recusa escrita", () => {
      expect(rolloutLib.isReadOnlyCommand("git", ["-C", "/tmp/x", "rev-parse", "HEAD"])).toBe(true);
      expect(rolloutLib.isReadOnlyCommand("git", ["-C", "/tmp/x", "ls-tree", "--name-only", "abc"])).toBe(true);
      expect(rolloutLib.isReadOnlyCommand("git", ["-C", "/tmp/x", "pull", "--ff-only"])).toBe(false);
      expect(rolloutLib.isReadOnlyCommand("git", ["-C", "/tmp/x", "checkout", "abc"])).toBe(false);
      expect(rolloutLib.isReadOnlyCommand("git", ["-C", "/tmp/x", "reset", "--hard"])).toBe(false);
    });
  });

  // --------------------------------------------------------------- wrapper
  describe("wrapper scripts/rollout-korrelo.sh", () => {
    it("valida o repositório com o Git (funciona em worktree, onde .git é arquivo)", () => {
      const script = fs.readFileSync(WRAPPER_PATH, "utf-8");
      expect(script).toContain("rev-parse --is-inside-work-tree");
      expect(script).not.toContain('[ -d "$REPO_ROOT/.git" ]');
    });

    it("repassa os argumentos intactos para o CLI", () => {
      const script = fs.readFileSync(WRAPPER_PATH, "utf-8");
      expect(script).toContain('exec node "$CLI" "$@"');
    });

    it("o wrapper repassa argumento desconhecido e o CLI aborta", () => {
      const probe = spawnSync("bash", ["--version"], { encoding: "utf-8" });
      if (probe.error) {
        // Sem bash no ambiente: a validação estática acima já cobre o caso.
        return;
      }
      const home = path.join(tmpDir, "home");
      fs.mkdirSync(home, { recursive: true });
      const result = spawnSync("bash", [WRAPPER_PATH, "--foobar"], {
        encoding: "utf-8",
        env: { ...process.env, HOME: home, USERPROFILE: home },
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("argumento inválido");
      expect(fs.existsSync(path.join(home, ".korrelo"))).toBe(false);
    });
  });
});

export {};
