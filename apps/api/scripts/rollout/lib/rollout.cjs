"use strict";

/**
 * Orquestrador do rollout do KORRELO.
 *
 * REGA MÁXIMA: o rollout mexe SOMENTE no Core (código, banco Core, PM2 do
 * Core, arquivos do Core). NENHUMA operação de escrita no Docker é feita -
 * os únicos comandos Docker são de LEITURA (`ps`, `inspect`), para provar
 * que os containers dos projetos não mudaram.
 *
 * O mesmo código serve o modo real e o modo dry-run: no dry-run, o
 * executor percorre os mesmos passos mas NENHUM deles é executado - apenas
 * o que SERIA feito é mostrado.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { inspectGitState, formatDirtyTreeMessage } = require("./git-state.cjs");
const { backupCoreDatabase, timestamp } = require("./core-backup.cjs");
const {
  captureProjectSnapshot,
  compareProjectSnapshots,
  formatSnapshotSummary,
} = require("./project-snapshot.cjs");
const { acquireLock, releaseLock, defaultLockPath } = require("./self-update-lock.cjs");

const STAGES = [
  { id: "preflight", title: "Verificar ambiente (git, disco, Docker, Core)", writes: false },
  { id: "lock", title: "Pegar o lock de rollout", writes: true },
  { id: "worker-drain", title: "Colocar o worker de deploy em draining", writes: true },
  { id: "git-check", title: "Verificar working tree (abortar se sujo)", writes: false },
  { id: "snapshot-before", title: "Snapshot dos containers de projeto (leitura)", writes: false },
  { id: "core-backup", title: "Backup consistente do banco do Core", writes: true },
  { id: "git-update", title: "git pull (só com working tree limpo)", writes: true },
  { id: "install", title: "npm install", writes: true },
  { id: "build-shared", title: "build shared-types", writes: true },
  { id: "build-api", title: "build da API", writes: true },
  { id: "build-web", title: "build do web", writes: true },
  {
    id: "web-assets",
    title: "Copiar .next/static e public/ para o standalone do Next",
    writes: true,
  },
  { id: "migration", title: "prisma migrate deploy (só após backup válido)", writes: true },
  { id: "permissions", title: "Permissões dos arquivos do Core (.env 600, dev.db 600)", writes: true },
  { id: "pm2-restart", title: "Reiniciar SOMENTE o PM2 do Korrelo", writes: true },
  { id: "health-core", title: "Health do Core (API, web, PM2, banco)", writes: false },
  { id: "snapshot-after", title: "Snapshot dos containers de projeto (leitura)", writes: false },
  { id: "compare-projects", title: "Comparar snapshots (divergência = falha crítica)", writes: false },
  { id: "worker-release", title: "Liberar o worker de deploy", writes: true },
  { id: "complete", title: "Concluído", writes: false },
];

/** Comandos de escrita PROIBIDOS durante o rollout (checa de guarda). */
const FORBIDDEN_DOCKER_COMMANDS = [
  "rm",
  "rmi",
  "stop",
  "start",
  "restart",
  "kill",
  "update",
  "run",
  "create",
  "up",
  "down",
  "exec",
  "compose",
];

/**
 * Percentual de progresso por stage (mesmo formato que a UI do Korrelo
 * consome: __KORRELO_UPDATE_STEP__|pct|label).
 */
const STAGE_PERCENT = {
  preflight: 2,
  lock: 4,
  "worker-drain": 5,
  "git-check": 8,
  "snapshot-before": 12,
  "core-backup": 15,
  "git-update": 20,
  install: 30,
  "build-shared": 40,
  "build-api": 55,
  "build-web": 70,
  "web-assets": 78,
  migration: 85,
  permissions: 90,
  "pm2-restart": 93,
  "health-core": 96,
  "snapshot-after": 98,
  "compare-projects": 99,
  "worker-release": 100,
  complete: 100,
};

function resolvePath(value, home = os.homedir()) {
  if (!value) return value;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

/**
 * Config padrão do rollout.
 *
 * `executorRoot`   = repositório onde está o CÓDIGO do rollout (o executor).
 * `targetRepoRoot` = checkout ALVO, que será atualizado (o que roda em
 *                     produção). Por padrão é o mesmo do executor.
 *
 * Os dois podem ser diferentes: o executor novo pode rodar de um worktree
 * externo (`/tmp/korrelo-rollout-preview`) e atualizar o checkout real
 * (`/home/korrelo/korrelo`).
 */
function defaultConfig(repoRoot) {
  return {
    executorRoot: repoRoot,
    targetRepoRoot: repoRoot,
    repoRoot,
    coreDbPath: path.join(repoRoot, "apps", "api", "prisma", "dev.db"),
    coreBackupDir: path.join(os.homedir(), "korrelo-backups"),
    coreEnvPath: path.join(repoRoot, "apps", "api", ".env"),
    projects: [],
    pm2Apps: ["korrelo-api", "korrelo-web"],
    apiHealthUrl: "http://127.0.0.1:3001/health",
    webHealthUrl: "http://127.0.0.1:3000/",
    lockPath: defaultLockPath(),
    drainFilePath: path.join(os.homedir(), ".korrelo", "worker-drain"),
    statusDir: path.join(os.homedir(), ".korrelo", "rollouts"),
  };
}

/**
 * Resolve os dois raízes do rollout.
 *
 * - targetRepoRoot: o checkout que será atualizado (git, banco, build,
 *   migration, chmod, rollback).
 * - executorRoot: onde mora o código do rollout (config, libs, commit do
 *   executor).
 *
 * `config.repoRoot` continua aceito como alias do alvo (compatibilidade com
 * as ondas anteriores, onde não havia a distinção).
 */
function resolveRoots(config) {
  const targetRepoRoot = path.resolve(config.targetRepoRoot ?? config.repoRoot);
  const executorRoot = path.resolve(config.executorRoot ?? config.repoRoot);
  return { targetRepoRoot, executorRoot };
}

/** Migrations presentes no repositório (nomes das pastas). */
function listMigrations({ repoRoot, migrationsDir = "apps/api/prisma/migrations" } = {}) {
  const dir = path.join(repoRoot, migrationsDir);
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Migrations presentes no COMMIT candidato do alvo (read-only).
 *
 * É o que será aplicado DEPOIS do update: o commit `origin/main` do checkout
 * alvo, lido direto da árvore do Git (`git ls-tree`), sem precisar fazer
 * checkout nem fetch.
 */
async function listMigrationsFromCommit({ repoRoot, commit, run, migrationsDir = "apps/api/prisma/migrations" }) {
  if (!commit) return [];
  const result = await run("git", ["-C", repoRoot, "ls-tree", "--name-only", commit, "--", `${migrationsDir}/`], {
    timeoutMs: 15_000,
  });
  if (result.code !== 0) return [];
  const prefix = `${migrationsDir}/`;
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length))
    .filter((name) => name && !name.includes("/"))
    .sort();
}

/**
 * Verifica se existe um deploy de projeto EM ANDAMENTO (read-only, direto
 * no banco do Core). Se houver, o rollout é abortado: atualizar o Korrelo no
 * meio de um deploy de projeto é proibido.
 *
 * Se a tabela ainda não existir (primeiro rollout, antes da migration), a
 * consulta falha e o resultado é tratado como "nenhum job em andamento".
 */
async function countActiveDeploys({ dbPath, run }) {
  const result = await run("sqlite3", [dbPath, "SELECT COUNT(*) FROM DeployJob WHERE status='running';"], {
    timeoutMs: 15_000,
  });
  if (result.code !== 0) return 0;
  const count = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(count) ? count : 0;
}

/**
 * Comandos PERMITIDOS no dry-run (todos somente leitura).
 *
 * O dry-run passa por aqui: qualquer comando fora da lista aborta o
 * dry-run com erro, em vez de escrever algo por acidente.
 */
const READ_ONLY_COMMANDS = {
  git: [
    "status",
    "rev-parse",
    "remote",
    "log",
    "show",
    "branch",
    "diff",
    "config",
    "ls-remote",
    "ls-tree",
    "merge-base",
  ],
  docker: ["ps", "inspect", "stats", "version", "info"],
  pm2: ["jlist", "status", "describe", "pid"],
  df: null,
  free: null,
  nproc: null,
  curl: null,
  sqlite3: null,
};

/**
 * Descobre o subcomando do Git pulando as opções GLOBAIS.
 *
 * `git -C <path> pull --ff-only` -> "pull"
 * `git rev-parse --abbrev-ref HEAD` -> "rev-parse"
 */
function gitSubcommand(args) {
  let index = 0;
  while (index < args.length) {
    const arg = String(args[index]);
    if (arg === "-C" || arg === "--git-dir" || arg === "--work-tree" || arg === "--namespace") {
      index += 2;
      continue;
    }
    if (arg === "-c" || arg === "--exec-path") {
      index += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  return args[index] === undefined ? null : String(args[index]);
}

function isReadOnlyCommand(command, args) {
  const allowed = READ_ONLY_COMMANDS[command];
  if (allowed === undefined) return false;
  if (allowed === null) {
    // Comandos sem subcomando: valida os argumentos.
    if (command === "sqlite3") {
      const sql = String(args[1] ?? "");
      return /^\s*(select|pragma)\b/i.test(sql);
    }
    if (command === "curl") {
      const joined = args.join(" ");
      if (/\s-X\s*(POST|PUT|DELETE|PATCH)\b/i.test(joined)) return false;
      if (/(\s|^)(-d|--data|--data-raw|--data-binary|--data-urlencode|-T|--upload-file|-F|--form)\b/.test(joined)) {
        return false;
      }
      return true;
    }
    return true;
  }
  return allowed.includes(gitSubcommand(args));
}

/**
 * Inspeção READ-ONLY do checkout ALVO.
 *
 * Usada pelo CLI antes de qualquer escrita: confirma que o caminho existe,
 * que é um repositório Git válido (funciona em worktree, onde `.git` é
 * ARQUIVO e não diretório) e qual branch/commit ele está.
 */
async function inspectTargetRepo({ targetRepoRoot, run, timeoutMs = 15_000 }) {
  const info = {
    path: targetRepoRoot,
    exists: false,
    isGit: false,
    branch: null,
    commit: null,
    candidate: null,
    detached: false,
    error: null,
  };

  if (!fs.existsSync(targetRepoRoot)) {
    info.error = `o caminho não existe: ${targetRepoRoot}`;
    return info;
  }
  info.exists = true;

  const inside = await run("git", ["-C", targetRepoRoot, "rev-parse", "--is-inside-work-tree"], {
    timeoutMs,
  });
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    info.error = `não é um repositório Git válido: ${targetRepoRoot}`;
    return info;
  }
  info.isGit = true;

  const branch = await run("git", ["-C", targetRepoRoot, "rev-parse", "--abbrev-ref", "HEAD"], {
    timeoutMs,
  });
  info.branch = branch.code === 0 ? branch.stdout.trim() || null : null;
  info.detached = info.branch === "HEAD" || info.branch === null;

  const commit = await run("git", ["-C", targetRepoRoot, "rev-parse", "HEAD"], { timeoutMs });
  info.commit = commit.code === 0 ? commit.stdout.trim() || null : null;

  const candidate = await run("git", ["-C", targetRepoRoot, "rev-parse", "--verify", "origin/main"], {
    timeoutMs,
  });
  info.candidate = candidate.code === 0 ? candidate.stdout.trim() || null : null;

  return info;
}

/**
 * Cria um runner que SÓ aceita comandos de leitura.
 *
 * Qualquer comando fora da allowlist aborta com erro - é a prova mecânica
 * de que o dry-run não escreve nada. O array `executed` fica com o rastro
 * de tudo que rodou (usado no relatório).
 */
function createReadOnlyRunner({ run, executed = [] }) {
  // Runner já protegido: reaproveita (sem duplicar o registro de comandos).
  if (run && run.__korreloReadOnlyRunner) {
    return { run, executed: run.__korreloExecuted };
  }
  const readOnlyRun = async (command, args = [], options = {}) => {
    if (!isReadOnlyCommand(command, args)) {
      throw new Error(
        `dry-run recusou o comando "${command} ${args[0] ?? ""}". O dry-run so executa leitura.`,
      );
    }
    executed.push({ command, args });
    return run(command, args, options);
  };
  readOnlyRun.__korreloReadOnlyRunner = true;
  readOnlyRun.__korreloExecuted = executed;
  return { run: readOnlyRun, executed };
}

/**
 * DRY-RUN REAL: executa TODAS as verificações somente leitura e devolve um
 * relatório. Não escreve NADA (nem lock, nem drain, nem backup, nem status).
 *
 * O runner é envolvido por um guard que aborta qualquer comando de escrita.
 */
async function runReadOnlyPreflight({ config, run, now = new Date(), executed = [] }) {
  const problems = [];
  const checks = [];

  const { run: readOnlyRun, executed: executedCommands } = createReadOnlyRunner({ run, executed });

  const check = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    if (!ok) problems.push(`${name}: ${detail}`);
    return ok;
  };

  const { targetRepoRoot, executorRoot } = resolveRoots(config);

  // ---------------------------------------------------------------- 1) Git do ALVO
  const git = await inspectGitState({ cwd: targetRepoRoot, run: readOnlyRun });
  const remoteResult = await readOnlyRun("git", ["-C", targetRepoRoot, "remote", "get-url", "origin"], {
    timeoutMs: 10_000,
  });
  const candidateResult = await readOnlyRun(
    "git",
    ["-C", targetRepoRoot, "rev-parse", "--verify", "origin/main"],
    { timeoutMs: 10_000 },
  );
  const candidateCommit = candidateResult.code === 0 ? candidateResult.stdout.trim() || null : null;

  const executorCommitResult = await readOnlyRun("git", ["-C", executorRoot, "rev-parse", "HEAD"], {
    timeoutMs: 10_000,
  });
  const executorCommit = executorCommitResult.code === 0 ? executorCommitResult.stdout.trim() || null : null;

  check(
    "git: working tree limpo",
    git.dirty === false,
    git.dirty
      ? `${git.trackedModified.length} modificado(s) e ${git.untracked.length} untracked`
      : "limpo",
  );

  const detached = git.branch === null || git.branch === "HEAD";
  check(
    "git: alvo está em uma branch (não detached)",
    !detached,
    detached ? `HEAD detached em ${git.commit ?? "?"}` : git.branch,
  );

  check(
    "git: candidato (origin/main) disponível",
    candidateCommit !== null,
    candidateCommit ?? "origin/main não encontrado localmente (o rollout não faz fetch automático)",
  );

  let fastForward = null;
  if (candidateCommit && git.commit) {
    const ancestor = await readOnlyRun(
      "git",
      ["-C", targetRepoRoot, "merge-base", "--is-ancestor", git.commit, candidateCommit],
      { timeoutMs: 10_000 },
    );
    fastForward = ancestor.code === 0;
  }
  check(
    "git: candidato é fast-forward do alvo",
    fastForward === true,
    fastForward === true
      ? `${String(git.commit).slice(0, 8)} -> ${String(candidateCommit).slice(0, 8)}`
      : "o candidato não é descendente do HEAD do alvo (fast-forward obrigatório)",
  );

  // ---------------------------------------------------------------- 2) Core
  const databaseExists = fs.existsSync(config.coreDbPath);
  const sqliteProbe = await readOnlyRun("sqlite3", [config.coreDbPath, "SELECT 1;"], { timeoutMs: 10_000 });
  const sqliteAccessible = sqliteProbe.code === 0;
  const activeDeploys = await countActiveDeploys({ dbPath: config.coreDbPath, run: readOnlyRun });
  const migrations = listMigrations({ repoRoot: targetRepoRoot });
  const migrationsCandidate = await listMigrationsFromCommit({
    repoRoot: targetRepoRoot,
    commit: candidateCommit,
    run: readOnlyRun,
  });
  check(
    "core: banco do Core acessível",
    databaseExists && sqliteAccessible,
    databaseExists ? (sqliteAccessible ? "ok" : "sqlite3 não respondeu") : `não encontrado: ${config.coreDbPath}`,
  );
  check(
    "core: nenhum deploy em andamento",
    activeDeploys === 0,
    activeDeploys === 0 ? "nenhum job running" : `${activeDeploys} job(s) running`,
  );

  // ---------------------------------------------------------------- 3) Host
  const diskResult = await readOnlyRun("df", ["-h", "/"], { timeoutMs: 10_000 });
  const memoryResult = await readOnlyRun("free", ["-m"], { timeoutMs: 10_000 });
  const dockerPs = await readOnlyRun("docker", ["ps", "--format", "{{.Names}}"], { timeoutMs: 15_000 });
  const dockerAccessible = dockerPs.code === 0;
  const pm2Result = await readOnlyRun("pm2", ["jlist"], { timeoutMs: 15_000 });
  const apiHealth = await readOnlyRun(
    "curl",
    ["-fsS", "--max-time", "10", config.apiHealthUrl],
    { timeoutMs: 20_000 },
  );
  const webHealth = await readOnlyRun(
    "curl",
    ["-fsS", "-o", "/dev/null", "--max-time", "15", config.webHealthUrl],
    { timeoutMs: 25_000 },
  );
  check("host: Docker acessível", dockerAccessible, dockerAccessible ? "ok" : "docker não respondeu");
  check("host: API responde", apiHealth.code === 0, config.apiHealthUrl);
  check("host: web responde", webHealth.code === 0, config.webHealthUrl);

  // ---------------------------------------------------------------- 4) Projetos
  const snapshot = await captureProjectSnapshot({ projects: config.projects, run: readOnlyRun, now });
  const containerCount = Object.values(snapshot.projects).reduce(
    (sum, project) => sum + Object.keys(project.containers ?? {}).length,
    0,
  );
  check(
    "projetos: containers inspecionados",
    config.projects.length === 0 || containerCount > 0,
    `${containerCount} container(s) de ${config.projects.length} projeto(s)`,
  );

  return {
    generatedAt: now.toISOString(),
    mode: "dry-run",
    executor: {
      root: executorRoot,
      commit: executorCommit,
    },
    target: {
      root: targetRepoRoot,
      branch: git.branch,
      commit: git.commit,
      candidateCommit,
      fastForward,
      detached,
    },
    git: {
      branch: git.branch,
      commit: git.commit,
      dirty: git.dirty,
      trackedModified: git.trackedModified,
      untracked: git.untracked,
      ignored: git.ignored,
      remote: remoteResult.code === 0 ? remoteResult.stdout.trim() : null,
      candidateCommit,
    },
    core: {
      databasePath: config.coreDbPath,
      databaseExists,
      sqliteAccessible,
      activeDeploys,
      migrations,
      migrationsCandidate,
    },
    host: {
      disk: diskResult.code === 0 ? diskResult.stdout.trim() : null,
      memory: memoryResult.code === 0 ? memoryResult.stdout.trim() : null,
      dockerAccessible,
      dockerContainers: dockerAccessible ? dockerPs.stdout.split("\n").filter(Boolean) : [],
      pm2: pm2Result.code === 0 ? safeParseJson(pm2Result.stdout) : null,
      apiHealth: apiHealth.code === 0,
      webHealth: webHealth.code === 0,
      apiHealthUrl: config.apiHealthUrl,
      webHealthUrl: config.webHealthUrl,
    },
    projects: snapshot.projects,
    problems,
    checks,
    executedCommands: executedCommands.map((entry) => `${entry.command} ${entry.args[0] ?? ""}`.trim()),
  };
}

function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Monta o plano (o que SERIA feito). Não executa nada.
 */
async function planRollout({ config, run, now = new Date() }) {
  const { targetRepoRoot, executorRoot } = resolveRoots(config);
  const git = await inspectGitState({ cwd: targetRepoRoot, run });
  const migrations = listMigrations({ repoRoot: targetRepoRoot });
  const backupName = `core-pre-update-${timestamp(now)}.db`;
  const activeDeploys = await countActiveDeploys({ dbPath: config.coreDbPath, run });
  const candidateResult = await run("git", ["-C", targetRepoRoot, "rev-parse", "--verify", "origin/main"], {
    timeoutMs: 10_000,
  });
  const candidateCommit = candidateResult.code === 0 ? candidateResult.stdout.trim() || null : null;
  const executorCommitResult = await run("git", ["-C", executorRoot, "rev-parse", "HEAD"], {
    timeoutMs: 10_000,
  });

  return {
    generatedAt: now.toISOString(),
    executor: {
      root: executorRoot,
      commit: executorCommitResult.code === 0 ? executorCommitResult.stdout.trim() || null : null,
    },
    target: {
      root: targetRepoRoot,
      branch: git.branch,
      commit: git.commit,
      candidateCommit,
      detached: git.branch === null || git.branch === "HEAD",
    },
    git: {
      branch: git.branch,
      commit: git.commit,
      dirty: git.dirty,
      trackedModified: git.trackedModified,
      untracked: git.untracked,
      ignored: git.ignored,
      candidateCommit,
    },
    activeDeploys,
    backup: {
      wouldCreate: path.join(resolvePath(config.coreBackupDir), backupName),
      database: config.coreDbPath,
      method: "sqlite3 .backup",
    },
    migrations,
    builds: [
      "npm run build --workspace=packages/shared-types",
      "npm run build --workspace=apps/api",
      "npm run build --workspace=apps/web",
    ],
    pm2: { restart: config.pm2Apps, onlyCore: true },
    projects: config.projects.map((project) => ({
      name: project.name,
      inspectedOnly: true,
    })),
    validations: {
      before: [
        "working tree limpo (abortar se sujo)",
        "nenhum deploy em andamento (nenhum job running)",
        "backup do banco do Core válido",
      ],
      after: [
        "GET /health da API responde",
        "web responde em 127.0.0.1:3000",
        "PM2: korrelo-api e korrelo-web online",
        "snapshot dos projetos IDÊNTICO ao de antes",
      ],
    },
    stages: STAGES,
  };
}

/**
 * Executa o rollout. Com dryRun=true, nada é executado.
 */
async function executeRollout({ config, run, log = () => {}, step = () => {}, dryRun = false, now = new Date() }) {
  const startedAt = new Date();
  const stages = [];
  const { targetRepoRoot, executorRoot } = resolveRoots(config);
  const state = {
    status: "running",
    stage: null,
    startedAt: startedAt.toISOString(),
    previousCommit: null,
    previousBranch: null,
    candidateCommit: null,
    backupPath: null,
    projectIntegrityCheck: null,
    error: null,
    // De onde veio o código que EXECUTOU o rollout e qual checkout foi
    // atualizado (podem ser coisas diferentes no primeiro rollout).
    executorRoot,
    executorCommit: null,
    targetRepoRoot,
    targetPreviousCommit: null,
    targetCandidateCommit: null,
  };

  const record = (id, status, detail = null) => {
    stages.push({ id, status, detail, at: new Date().toISOString() });
    state.stage = id;
    log(`[rollout] ${id}: ${status}${detail ? ` - ${detail}` : ""}`);
    // Marcador de progresso no mesmo formato que a UI do Korrelo consome.
    const percent = STAGE_PERCENT[id];
    if (percent !== undefined) step(percent, id);
  };

  const writeStatus = () => {
    try {
      fs.mkdirSync(config.statusDir, { recursive: true });
      const dir = path.join(config.statusDir, timestamp(now));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(state, null, 2));
      fs.writeFileSync(path.join(config.statusDir, "last.json"), JSON.stringify(state, null, 2));
    } catch {
      /* status é best effort */
    }
  };

  let lockPath = null;
  let snapshotBefore = null;
  // O rollback só faz sentido se o checkout alvo foi de fato atualizado.
  // Abortos que acontecem ANTES do git update (working tree sujo, alvo
  // detached, candidato sem fast-forward, deploy em andamento) NÃO podem
  // escrever nada no Git do alvo.
  let targetUpdated = false;

  try {
    // ---------------------------------------------------------------- dry-run
    if (dryRun) {
      // DRY-RUN REAL: executa todas as verificações somente leitura (git,
      // core, host, health e snapshot real dos projetos) e NÃO escreve nada -
      // nem lock, nem drain, nem backup, nem arquivo de status.
      //
      // Tudo passa pelo runner com guard: um comando de escrita aborta o
      // dry-run com erro em vez de acontecer de verdade.
      const executed = [];
      const { run: readOnlyRun } = createReadOnlyRunner({ run, executed });
      const plan = await planRollout({ config, run: readOnlyRun, now });
      state.executorCommit = plan.executor.commit;
      state.previousCommit = plan.git.commit;
      state.targetPreviousCommit = plan.git.commit;
      state.previousBranch = plan.git.branch;
      state.candidateCommit = plan.target.candidateCommit;
      state.targetCandidateCommit = plan.target.candidateCommit;

      const preflight = await runReadOnlyPreflight({ config, run: readOnlyRun, now, executed });
      state.status = "dry-run";
      log(`[rollout] dry-run: ${preflight.checks.length} verificação(ões) somente leitura concluída(s)`);
      for (const problem of preflight.problems) {
        log(`[rollout] dry-run: PROBLEMA - ${problem}`);
      }
      // Sem writeStatus(): o dry-run não deixa rastro em disco.
      return {
        ok: preflight.problems.length === 0,
        dryRun: true,
        state,
        plan,
        stages,
        preflight,
      };
    }

    // ---------------------------------------------------------------- preflight
    const plan = await planRollout({ config, run, now });
    state.executorCommit = plan.executor.commit;
    state.previousCommit = plan.git.commit;
    state.targetPreviousCommit = plan.git.commit;
    state.previousBranch = plan.git.branch;
    state.candidateCommit = plan.target.candidateCommit;
    state.targetCandidateCommit = plan.target.candidateCommit;

    // Nenhum rollout do Core começa no meio de um deploy de projeto.
    if (plan.activeDeploys > 0) {
      throw new Error(
        `Existe ${plan.activeDeploys} deploy(s) de projeto em andamento: o rollout do Korrelo foi recusado. ` +
          "Nenhum rollout do Core começa no meio de um deploy - tente novamente assim que o deploy terminar.",
      );
    }
    record(
      "preflight",
      "ok",
      `alvo=${targetRepoRoot} branch=${plan.git.branch} commit=${String(plan.git.commit).slice(0, 8)} ` +
        `candidato=${String(plan.target.candidateCommit ?? "?").slice(0, 8)}`,
    );

    // ---------------------------------------------------------------- lock
    const lock = acquireLock({ lockPath: config.lockPath });
    if (!lock.acquired) {
      throw new Error(`rollout recusado: ${lock.reason}`);
    }
    lockPath = lock.path;
    record("lock", "ok", lockPath);

    // ---------------------------------------------------------------- drain
    fs.mkdirSync(path.dirname(config.drainFilePath), { recursive: true });
    fs.writeFileSync(config.drainFilePath, JSON.stringify({ at: new Date().toISOString(), reason: "rollout" }));
    record("worker-drain", "ok", config.drainFilePath);

    // ---------------------------------------------------------------- git check
    const git = await inspectGitState({ cwd: targetRepoRoot, run });
    if (git.dirty) {
      throw new Error(formatDirtyTreeMessage(git));
    }

    // O alvo precisa estar em uma BRANCH. Em detached HEAD o `git pull`
    // falha com "You are not currently on a branch" (e foi exatamente o que
    // aconteceu no incidente do primeiro rollout).
    const targetBranch = git.branch;
    if (!targetBranch || targetBranch === "HEAD") {
      throw new Error(
        `o checkout alvo está em detached HEAD (${String(git.commit).slice(0, 8)}): ` +
          "o rollout do Core só roda em uma branch do checkout alvo.",
      );
    }

    // Fast-forward OBRIGATÓRIO: o candidato (origin/main) precisa ser
    // descendente do HEAD atual do alvo. Nunca há reset nem merge - se não
    // for fast-forward, o checkout alvo não é tocado.
    if (!state.candidateCommit) {
      throw new Error(
        "origin/main não encontrado no checkout alvo (o rollout não faz fetch automático): nada foi alterado.",
      );
    }
    const ancestor = await run(
      "git",
      ["-C", targetRepoRoot, "merge-base", "--is-ancestor", String(git.commit), String(state.candidateCommit)],
      { timeoutMs: 15_000 },
    );
    if (ancestor.code !== 0) {
      throw new Error(
        `fast-forward obrigatório: ${String(state.candidateCommit).slice(0, 8)} (origin/main) não é descendente de ` +
          `${String(git.commit).slice(0, 8)} (HEAD do alvo). O checkout alvo não será alterado ` +
          "(nem reset, nem merge).",
      );
    }
    record("git-check", "ok", `working tree limpo, branch=${targetBranch}, fast-forward ok`);

    // ---------------------------------------------------------------- snapshot before
    snapshotBefore = await captureProjectSnapshot({ projects: config.projects, run, now });
    record("snapshot-before", "ok", `${Object.keys(snapshotBefore.projects).length} projeto(s) inspecionado(s)`);
    log(formatSnapshotSummary(snapshotBefore));

    // ---------------------------------------------------------------- backup
    const backup = await backupCoreDatabase({
      dbPath: config.coreDbPath,
      backupDir: resolvePath(config.coreBackupDir),
      run,
      now,
    });
    if (!backup.ok) {
      // O caminho do backup é registrado mesmo na falha: o operador precisa
      // saber qual arquivo foi criado (e onde).
      state.backupPath = backup.path;
      throw new Error(`backup do banco do Core falhou: ${backup.problems.join("; ")}`);
    }
    state.backupPath = backup.path;
    record("core-backup", "ok", `${backup.path} (${backup.bytes} bytes)`);

    // ---------------------------------------------------------------- git update
    // O pull acontece NO CHECKOUT ALVO, com a branch explícita - nunca no
    // repositório do executor (que pode ser um worktree detached).
    const pull = await run("git", ["-C", targetRepoRoot, "pull", "--ff-only", "origin", targetBranch], {
      cwd: targetRepoRoot,
      timeoutMs: 120_000,
    });
    if (pull.code !== 0) {
      throw new Error(`git pull falhou: ${pull.stderr.trim() || pull.stdout.trim()}`);
    }
    const candidate = await run("git", ["-C", targetRepoRoot, "rev-parse", "HEAD"], {
      cwd: targetRepoRoot,
    });
    state.candidateCommit = candidate.stdout.trim();
    state.targetCandidateCommit = state.candidateCommit;
    targetUpdated = true;
    record("git-update", "ok", String(state.candidateCommit).slice(0, 8));

    // ---------------------------------------------------------------- install
    const install = await run("npm", ["install"], { cwd: targetRepoRoot, timeoutMs: 900_000 });
    if (install.code !== 0) {
      throw new Error("npm install falhou");
    }
    record("install", "ok");

    // ---------------------------------------------------------------- builds
    for (const [id, workspace] of [
      ["build-shared", "packages/shared-types"],
      ["build-api", "apps/api"],
      ["build-web", "apps/web"],
    ]) {
      const build = await run("npm", ["run", "build", `--workspace=${workspace}`], {
        cwd: targetRepoRoot,
        timeoutMs: 1_800_000,
      });
      if (build.code !== 0) {
        throw new Error(`build de ${workspace} falhou`);
      }
      record(id, "ok", workspace);
    }

    // ---------------------------------------------------------------- web assets
    // O Next em modo "standalone" NÃO serve .next/static nem public/ sozinho:
    // o postbuild já copia, mas o rollout copia de novo (idempotente) para
    // garantir - o web não pode ficar sem CSS/JS depois do update.
    const assetsScript = path.join(targetRepoRoot, "apps", "web", "scripts", "copy-standalone-assets.js");
    const assets = await run(process.execPath, [assetsScript], {
      cwd: path.join(targetRepoRoot, "apps", "web"),
      timeoutMs: 120_000,
    });
    if (assets.code !== 0) {
      record("web-assets", "failed", "falha ao copiar os assets do Next para o standalone");
      throw new Error(
        `falha ao copiar os assets do Next (.next/static e public/) para o standalone: ${
          assets.stderr.trim() || "erro desconhecido"
        }`,
      );
    }
    record("web-assets", "ok", ".next/static e public/ copiados para o standalone");

    // ---------------------------------------------------------------- migration
    const migrate = await run("npx", ["prisma", "migrate", "deploy"], {
      cwd: path.join(targetRepoRoot, "apps", "api"),
      timeoutMs: 600_000,
    });
    if (migrate.code !== 0) {
      throw new Error(`prisma migrate deploy falhou: ${migrate.stderr.trim() || migrate.stdout.trim()}`);
    }
    record("migration", "ok", `${plan.migrations.length} migration(s) no repositório`);

    // ---------------------------------------------------------------- permissões
    for (const [file, mode] of [
      [config.coreEnvPath, "600"],
      [config.coreDbPath, "600"],
    ]) {
      if (!fs.existsSync(file)) continue;
      const chmod = await run("chmod", [mode, file], { cwd: targetRepoRoot });
      if (chmod.code !== 0) {
        record("permissions", "warn", `não foi possível aplicar ${mode} em ${file}`);
        continue;
      }
    }
    record("permissions", "ok", ".env e dev.db com 600");

    // ---------------------------------------------------------------- pm2 (só o Core)
    const pm2 = await run("pm2", ["restart", ...config.pm2Apps], { cwd: targetRepoRoot, timeoutMs: 120_000 });
    if (pm2.code !== 0) {
      throw new Error("pm2 restart do Korrelo falhou");
    }
    record("pm2-restart", "ok", config.pm2Apps.join(", "));

    // ---------------------------------------------------------------- health do Core
    const apiHealth = await run("curl", ["-fsS", "--max-time", "10", config.apiHealthUrl], { timeoutMs: 20_000 });
    if (apiHealth.code !== 0) {
      throw new Error(`health da API falhou: ${config.apiHealthUrl}`);
    }
    const webHealth = await run(
      "curl",
      ["-fsS", "-o", "/dev/null", "--max-time", "15", config.webHealthUrl],
      { timeoutMs: 25_000 },
    );
    if (webHealth.code !== 0) {
      throw new Error(`health do web falhou: ${config.webHealthUrl}`);
    }
    record("health-core", "ok", "API e web respondendo");

    // ---------------------------------------------------------------- snapshot after + comparação
    const snapshotAfter = await captureProjectSnapshot({ projects: config.projects, run, now });
    record("snapshot-after", "ok");

    const comparison = compareProjectSnapshots(snapshotBefore, snapshotAfter);
    state.projectIntegrityCheck = comparison.ok ? "intacto" : "DIVERGENTE";
    if (!comparison.ok) {
      for (const change of comparison.changes) {
        log(
          `[rollout] DIVERGÊNCIA CRÍTICA: ${change.project}/${change.container} ${change.field}: ` +
            `${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`,
        );
      }
      throw new Error(
        "DIVERGÊNCIA CRÍTICA: containers de projeto mudaram durante o rollout do Korrelo. " +
          "NÃO reinicie nem recrie os projetos - investigue manualmente.",
      );
    }
    record("compare-projects", "ok", "containers de projeto idênticos");

    // ---------------------------------------------------------------- liberar worker
    try {
      fs.rmSync(config.drainFilePath, { force: true });
    } catch {
      /* best effort */
    }
    record("worker-release", "ok");

    state.status = "completed";
    record("complete", "ok");
    writeStatus();
    return { ok: true, dryRun: false, state, plan, stages, comparison };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    state.status = "failed";
    state.error = message;
    record(state.stage || "unknown", "failed", message);
    writeStatus();

    // Rollback do CORE (nunca dos projetos). Só roda se o checkout alvo foi
    // atualizado: abortos anteriores ao git update não têm o que reverter
    // (e não podem escrever nada no Git do alvo).
    const rollback = targetUpdated
      ? await rollbackCore({ config, run, log, previousCommit: state.previousCommit })
      : {
          ok: false,
          skipped: true,
          reason: "o checkout alvo não foi atualizado (abortado antes do git update): nada a reverter",
          steps: [],
        };
    state.rollback = rollback;

    // Libera o worker (o Core precisa voltar a funcionar).
    try {
      fs.rmSync(config.drainFilePath, { force: true });
    } catch {
      /* best effort */
    }

    writeStatus();
    return { ok: false, dryRun: false, state, stages, error: message, rollback };
  } finally {
    if (lockPath && !dryRun) {
      releaseLock(lockPath);
    }
  }
}

/**
 * Rollback do CORE: volta ao commit anterior, rebuild e reinicia SOMENTE
 * korrelo-api e korrelo-web. NUNCA toca em container de projeto.
 *
 * O rollback acontece NO CHECKOUT ALVO (o mesmo que foi atualizado): volta
 * para o previousCommit capturado ANTES do git update.
 */
async function rollbackCore({ config, run, log = () => {}, previousCommit }) {
  if (!previousCommit) {
    return { ok: false, reason: "commit anterior desconhecido" };
  }
  const { targetRepoRoot } = resolveRoots(config);
  const steps = [];

  const checkout = await run("git", ["-C", targetRepoRoot, "checkout", previousCommit], {
    cwd: targetRepoRoot,
    timeoutMs: 60_000,
  });
  steps.push({ step: "git-checkout", code: checkout.code });
  if (checkout.code !== 0) {
    return { ok: false, reason: `git checkout falhou: ${checkout.stderr.trim()}`, steps };
  }

  for (const workspace of ["packages/shared-types", "apps/api", "apps/web"]) {
    const build = await run("npm", ["run", "build", `--workspace=${workspace}`], {
      cwd: targetRepoRoot,
      timeoutMs: 1_800_000,
    });
    steps.push({ step: `build-${workspace}`, code: build.code });
    if (build.code !== 0) {
      return { ok: false, reason: `build de ${workspace} falhou no rollback`, steps };
    }
  }

  // Os assets do Next standalone também voltam (o web não pode ficar sem
  // CSS/JS depois do rollback).
  const assetsScript = path.join(targetRepoRoot, "apps", "web", "scripts", "copy-standalone-assets.js");
  const assets = await run(process.execPath, [assetsScript], {
    cwd: path.join(targetRepoRoot, "apps", "web"),
    timeoutMs: 120_000,
  });
  steps.push({ step: "web-assets", code: assets.code });

  // SOMENTE os processos do Core. Projetos não são tocados.
  const pm2 = await run("pm2", ["restart", ...config.pm2Apps], { cwd: targetRepoRoot, timeoutMs: 120_000 });
  steps.push({ step: "pm2-restart-core", code: pm2.code });
  if (pm2.code !== 0) {
    return { ok: false, reason: "pm2 restart falhou no rollback", steps };
  }

  const health = await run("curl", ["-fsS", "--max-time", "10", config.apiHealthUrl], { timeoutMs: 20_000 });
  steps.push({ step: "health-api", code: health.code });
  if (health.code !== 0) {
    return { ok: false, reason: "health da API falhou após rollback", steps };
  }

  log("[rollout] rollback do Core concluído (projetos não foram tocados)");
  return { ok: true, reason: null, steps };
}

module.exports = {
  STAGES,
  STAGE_PERCENT,
  FORBIDDEN_DOCKER_COMMANDS,
  READ_ONLY_COMMANDS,
  isReadOnlyCommand,
  gitSubcommand,
  createReadOnlyRunner,
  runReadOnlyPreflight,
  inspectTargetRepo,
  listMigrationsFromCommit,
  resolveRoots,
  planRollout,
  executeRollout,
  rollbackCore,
  listMigrations,
  defaultConfig,
};
