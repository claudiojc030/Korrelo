#!/usr/bin/env node
"use strict";

/**
 * CLI do rollout do Korrelo.
 *
 *   node rollout.cjs --plan                     # só o plano teórico
 *   node rollout.cjs                            # dry-run REAL (read-only)
 *   node rollout.cjs --apply                    # rollout de verdade
 *   node rollout.cjs --repo-root <path>         # dry-run REAL no checkout alvo
 *   node rollout.cjs --repo-root <path> --apply # rollout de verdade no alvo
 *
 * Modos:
 *  - --plan: imprime o plano. NÃO fala com Docker nem com o banco.
 *  - (sem argumentos): DRY-RUN REAL - executa todas as verificações somente
 *    leitura (git, core, host, health, snapshot real dos projetos) e não
 *    escreve NADA (sem lock, sem drain, sem backup, sem arquivo de status).
 *  - --apply: o rollout de verdade (com backup, migration, build e restart
 *    do Core).
 *
 * EXECUTOR vs ALVO:
 *  - executorRoot   = onde está este código (worktree do operador).
 *  - targetRepoRoot = o checkout do Korrelo que será atualizado (produção).
 *
 * Com `--repo-root <path>` o executor pode ser NOVO (worktree detached) e o
 * alvo ser o checkout ANTIGO em produção: o código, a config e as libs do
 * rollout vêm sempre do executor; o alvo é só o que é atualizado.
 *
 * Argumento desconhecido ABORTA. Nunca é ignorado.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { run } = require("./lib/command-runner.cjs");
const {
  planRollout,
  executeRollout,
  defaultConfig,
  inspectTargetRepo,
} = require("./lib/rollout.cjs");
const { parseArgs, USAGE } = require("./lib/cli-args.cjs");
const { applyMarker, parseMarker, sanitizeReason, updateJob } = require("./lib/self-update-job.cjs");

const EXECUTOR_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const CONFIG_PATH = path.join(EXECUTOR_ROOT, "apps", "api", "scripts", "rollout", "rollout.config.json");

/**
 * Arquivo do job de self-update (quando este rollout foi disparado pelo
 * painel do Korrelo).
 *
 * O RUNNER é o DONO da atualização: quem escreve o progresso e o resultado
 * final é o próprio rollout - a API pode estar reiniciando no meio e não
 * pode ser dependência. Sem o job (rollout externo por SSH), nada muda.
 */
const JOB_FILE = (() => {
  const argv = process.argv.slice(2);
  const index = argv.indexOf("--job-file");
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  return process.env.KORRELO_SELF_UPDATE_JOB_FILE || null;
})();
/** Aplica um marcador (STEP/DONE/META) ao job persistido. */
function persistMarker(marker) {
  if (!JOB_FILE) return;
  try {
    applyMarker(JOB_FILE, marker);
  } catch {
    /* persistência é best effort: nunca deve derrubar o rollout */
  }
}

/** Atualiza o job persistido com um patch. */
function persistJob(patch) {
  if (!JOB_FILE) return;
  try {
    updateJob(JOB_FILE, patch);
  } catch {
    /* best effort */
  }
}

/**
 * Finaliza o job com uma falha.
 *
 * O job NUNCA pode ficar "running" eternamente: qualquer saída do CLI (abort
 * de validação, erro inesperado, falha do rollout) precisa deixar o estado
 * final gravado - é a API que vai ler esse estado para a UI.
 */
function failJob(reason) {
  if (!JOB_FILE) return;
  const message = sanitizeReason(reason);
  try {
    updateJob(JOB_FILE, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      result: "failed",
      failureReason: message,
    });
  } catch {
    /* best effort */
  }
}

/**
 * Monta a config do rollout.
 *
 * A config dos projetos vem SEMPRE do executor (a versão nova). O alvo só
 * define ONDE o Git, o banco do Core, o build e a migration acontecem.
 */
function loadConfig({ executorRoot, repoRoot }) {
  const base = defaultConfig(executorRoot);
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    file = {};
  }
  const targetRepoRoot = path.resolve(repoRoot ?? executorRoot);
  return {
    ...base,
    ...file,
    executorRoot,
    targetRepoRoot,
    // alias de compatibilidade: o alvo é o "repoRoot" do rollout.
    repoRoot: targetRepoRoot,
    coreDbPath: path.join(targetRepoRoot, "apps", "api", "prisma", "dev.db"),
    coreEnvPath: path.join(targetRepoRoot, "apps", "api", ".env"),
    coreBackupDir: path.join(os.homedir(), "korrelo-backups"),
    artifactBackupDir: path.join(os.homedir(), "korrelo-artifact-backups"),
  };
}

function printPlan(plan) {
  console.log("=== PLANO DE ROLLOUT DO KORRELO (nada será executado) ===");
  console.log(`executor:             ${plan.executor.root} (${plan.executor.commit ?? "?"})`);
  console.log(`checkout alvo:        ${plan.target.root}`);
  console.log(`branch alvo:          ${plan.target.branch ?? "(detached)"}`);
  console.log(`commit atual do alvo: ${plan.git.commit}`);
  console.log(`candidato (origin/main): ${plan.git.candidateCommit ?? "(não encontrado)"}`);
  console.log(`working tree limpo:  ${plan.git.dirty ? "NÃO" : "sim"}`);
  if (plan.git.dirty) {
    console.log("  tracked modificados:");
    for (const file of plan.git.trackedModified) console.log(`    ${file}`);
    console.log("  untracked:");
    for (const file of plan.git.untracked) console.log(`    ${file}`);
  }
  console.log(`backup do Core:      ${plan.backup.wouldCreate} (${plan.backup.method})`);
  console.log(`banco do Core:       ${plan.backup.database}`);
  console.log(`migrations no repo:  ${plan.migrations.join(", ") || "(nenhuma)"}`);
  console.log("builds:");
  for (const build of plan.builds) console.log(`  ${build}`);
  console.log(`PM2 reiniciado:      ${plan.pm2.restart.join(", ")} (somente o Core)`);
  console.log("containers de projeto (apenas inspecionados):");
  for (const project of plan.projects) console.log(`  ${project.name}`);
  console.log("validações antes:");
  for (const item of plan.validations.before) console.log(`  - ${item}`);
  console.log("validações depois:");
  for (const item of plan.validations.after) console.log(`  - ${item}`);
  console.log("stages:");
  for (const stage of plan.stages) {
    console.log(`  ${stage.id.padEnd(20)} ${stage.writes ? "escreve" : "somente leitura"} - ${stage.title}`);
  }
}

function printPreflight(report) {
  console.log("=== DRY-RUN REAL (somente leitura, nada foi alterado) ===");
  console.log(`gerado em:            ${report.generatedAt}`);
  console.log("");
  console.log("-- EXECUTOR (código que roda o rollout) --");
  console.log(`raiz:                 ${report.executor.root}`);
  console.log(`commit:               ${report.executor.commit ?? "?"}`);
  console.log("");
  console.log("-- ALVO (checkout que seria atualizado) --");
  console.log(`raiz:                 ${report.target.root}`);
  console.log(`branch:               ${report.target.branch ?? "(detached)"}`);
  console.log(`commit:               ${report.target.commit ?? "?"}`);
  console.log(`candidato (origin/main): ${report.target.candidateCommit ?? "?"}`);
  console.log(`fast-forward:         ${report.target.fastForward === null ? "?" : report.target.fastForward ? "sim" : "NÃO"}`);
  console.log("");
  console.log("-- GIT --");
  console.log(`branch:               ${report.git.branch}`);
  console.log(`commit:               ${report.git.commit}`);
  console.log(`remoto:               ${report.git.remote ?? "?"}`);
  console.log(`candidato (local):    ${report.git.candidateCommit ?? "?"}`);
  console.log(`working tree:         ${report.git.dirty ? "SUJO" : "limpo"}`);
  for (const file of report.git.trackedModified) console.log(`  modificado: ${file}`);
  for (const file of report.git.untracked) console.log(`  untracked:  ${file}`);

  console.log("");
  console.log("-- CORE --");
  console.log(`banco:                ${report.core.databasePath}`);
  console.log(`existe:               ${report.core.databaseExists ? "sim" : "NÃO"}`);
  console.log(`sqlite acessível:     ${report.core.sqliteAccessible ? "sim" : "NÃO"}`);
  console.log(`deploys em andamento:  ${report.core.activeDeploys}`);
  console.log(`migrations no alvo:   ${report.core.migrations.join(", ") || "(nenhuma)"}`);
  console.log(`migrations candidato: ${report.core.migrationsCandidate.join(", ") || "(nenhuma)"}`);

  console.log("");
  console.log("-- HOST --");
  console.log(`docker acessível:     ${report.host.dockerAccessible ? "sim" : "NÃO"}`);
  console.log(`containers docker:    ${report.host.dockerContainers.length}`);
  console.log(`API (${report.host.apiHealthUrl}): ${report.host.apiHealth ? "responde" : "NÃO responde"}`);
  console.log(`web (${report.host.webHealthUrl}): ${report.host.webHealth ? "responde" : "NÃO responde"}`);
  if (report.host.disk) {
    console.log("-- disco --");
    console.log(report.host.disk);
  }
  if (report.host.memory) {
    console.log("-- memória --");
    console.log(report.host.memory);
  }
  if (Array.isArray(report.host.pm2)) {
    console.log("-- PM2 --");
    for (const app of report.host.pm2) {
      console.log(`  ${app.name}: ${app.pm2_env?.status ?? "?"}`);
    }
  }

  console.log("");
  console.log("-- RECURSOS DO HOST (para buildar o Core com segurança) --");
  const resource = report.rolloutResourceCheck ?? {};
  console.log(`memória disponível:   ${resource.memAvailableMb ?? "?"} MB (exigido: ${resource.memRequiredMb ?? "?"} MB)`);
  console.log(`swap em uso:          ${resource.swapUsedMb ?? "?"} MB (máximo: ${resource.swapThresholdMb ?? "?"} MB)`);
  const activity = resource.swapActivity;
  const pressure = resource.memoryPressure;
  console.log(
    `atividade de swap:   ${activity?.available ? `${activity.swapInDelta ?? "?"} in / ${activity.swapOutDelta ?? "?"} out (páginas)` : "indisponível"}`,
  );
  console.log(
    `PSI de memória:       ${pressure?.available ? `some=${pressure.someAvg10 ?? "?"} full=${pressure.fullAvg10 ?? "?"}` : "indisponível"}`,
  );
  console.log(`load average (1min):  ${resource.load1 ?? "?"}`);
  console.log(`disco livre:          ${resource.diskAvailableGb ?? "?"} GB`);
  console.log(`pode buildar:         ${resource.safeToBuild ? "SIM" : "NÃO"} - ${resource.reason ?? "?"}`);

  console.log("");
  console.log("-- PROJETOS (snapshot somente leitura) --");
  for (const [project, data] of Object.entries(report.projects)) {
    for (const [container, info] of Object.entries(data.containers ?? {})) {
      console.log(`  ${project}/${container}`);
      console.log(`    id=${info.id}`);
      console.log(`    image=${info.image}`);
      console.log(`    startedAt=${info.startedAt}`);
      console.log(`    restartCount=${info.restartCount}`);
      console.log(`    memoria=${info.memoryLimitBytes} swap=${info.memorySwapBytes}`);
      console.log(`    restartPolicy=${info.restartPolicy} health=${info.health ?? "n/a"}`);
      console.log(`    networks=[${(info.networks ?? []).join(",")}] ports=[${(info.ports ?? []).join(",")}]`);
      console.log(
        `    mounts=[${(info.mounts ?? []).map((m) => `${m.name ?? ""}:${m.destination ?? ""}`).join(", ")}]`,
      );
    }
  }

  console.log("");
  console.log("-- VERIFICAÇÕES --");
  for (const check of report.checks) {
    console.log(`  ${check.ok ? "OK  " : "FALHA"} ${check.name}${check.detail ? ` (${check.detail})` : ""}`);
  }

  console.log("");
  console.log("-- COMANDOS EXECUTADOS (todos somente leitura) --");
  for (const command of report.executedCommands) {
    console.log(`  ${command}`);
  }
}

async function main() {
  // ---------------------------------------------------------------- parsing
  // Argumento desconhecido ABORTA aqui: antes de qualquer lock, drain,
  // backup, pull, build ou migration.
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[rollout] ERRO: ${error.message}`);
    console.error(`[rollout] ${USAGE}`);
    console.error("[rollout] nada foi executado (sem lock, sem drain, sem backup).");
    failJob(error.message);
    process.exit(1);
  }

  const config = loadConfig({ executorRoot: EXECUTOR_ROOT, repoRoot: args.repoRoot });

  // ------------------------------------------------- validação do checkout alvo
  const target = await inspectTargetRepo({ targetRepoRoot: config.targetRepoRoot, run });
  if (target.error) {
    console.error(`[rollout] ERRO: checkout alvo inválido: ${target.error}`);
    console.error("[rollout] nada foi executado (sem lock, sem drain, sem backup).");
    failJob(`checkout alvo inválido: ${target.error}`);
    process.exit(1);
  }

  console.log(`[rollout] executor: ${config.executorRoot}`);
  console.log(`[rollout] checkout alvo: ${config.targetRepoRoot} (branch=${target.branch ?? "detached"})`);

  if (args.mode === "apply" && target.detached) {
    console.error(
      "[rollout] ERRO: o checkout alvo está em detached HEAD: o rollout do Core só roda em uma branch.",
    );
    console.error("[rollout] nada foi executado (sem lock, sem drain, sem backup).");
    failJob("o checkout alvo está em detached HEAD");
    process.exit(1);
  }

  // ------------------------------------------------------------------ --plan
  if (args.mode === "plan") {
    const plan = await planRollout({ config, run });
    printPlan(plan);
    if (plan.git.dirty) {
      console.log("");
      console.log("Working tree contains local changes:");
      for (const file of plan.git.trackedModified) console.log(` ${file}`);
      for (const file of plan.git.untracked) console.log(` ${file}`);
      console.log("");
      console.log("Update aborted. Review or stash/restore explicitly.");
      process.exit(2);
    }
    console.log("");
    console.log("PLANO apenas (--plan): nada foi executado e nada foi lido do Docker.");
    process.exit(0);
  }

  // ------------------------------------------------------- dry-run (default)
  if (args.mode === "dry-run") {
    const result = await executeRollout({
      config,
      run,
      log: (line) => console.log(line),
      dryRun: true,
    });
    const report = result.preflight;
    if (!report) {
      console.error("dry-run não produziu relatório");
      process.exit(1);
    }
    printPreflight(report);
    console.log("");
    if (report.problems.length > 0) {
      console.log("PROBLEMAS ENCONTRADOS (o rollout real seria abortado):");
      for (const problem of report.problems) console.log(`  - ${problem}`);
      console.log("");
      console.log("Nada foi alterado: dry-run é somente leitura.");
      if (report.git.dirty) {
        console.log("");
        console.log("Working tree contains local changes:");
        for (const file of report.git.trackedModified) console.log(` ${file}`);
        for (const file of report.git.untracked) console.log(` ${file}`);
        console.log("");
        console.log("Update aborted. Review or stash/restore explicitly.");
        process.exit(2);
      }
      process.exit(1);
    }
    console.log("Nada foi alterado: dry-run é somente leitura.");
    process.exit(0);
  }

  // ------------------------------------------------------------------ --apply
  const result = await executeRollout({
    config,
    run,
    log: (line) => console.log(line),
    // Marcadores de progresso no formato que a UI do Korrelo consome
    // (o botão "Atualizar agora" mostra a barra de progresso e o log).
    step: (percent, label) => {
      const line = `__KORRELO_UPDATE_STEP__|${percent}|${label}`;
      console.log(line);
      // O runner persiste o progresso no job (a API pode reiniciar).
      persistMarker(parseMarker(line));
    },
    // Metadados estruturados do update (commits e branch).
    meta: (key, value) => {
      const line = `__KORRELO_UPDATE_META__|${key}|${value}`;
      console.log(line);
      persistMarker(parseMarker(line));
    },
  });
  if (!result.ok) {
    console.error("");
    console.error(`ROLLOUT FALHOU: ${result.error}`);
    if (result.state && result.state.backupPath) {
      console.error(`Backup do Core criado em: ${result.state.backupPath}`);
    }
    if (result.rollback) {
      if (result.rollback.skipped) {
        console.error(`Rollback do Core não foi necessário: ${result.rollback.reason}`);
      } else if (result.rollback.deferred) {
        console.error("");
        console.error(`[${result.rollback.status}] ${result.rollback.reason}`);
        console.error(
          "Os containers de produção (Mesatta, Mongo, Evolution, Postgres, Redis) NÃO foram tocados.",
        );
      } else {
        console.error(
          result.rollback.ok
            ? "Rollback do Core concluído (os projetos NÃO foram tocados)."
            : `Rollback do Core falhou: ${result.rollback.reason}`,
        );
      }
      // O estado da recuperação entra no job (RECOVERY_DEFERRED/REQUIRED).
      if (result.rollback.status) {
        persistJob({
          recoveryStatus: result.rollback.status,
          status: result.rollback.deferred ? "recovery_deferred" : "failed",
        });
      }
    }
    const failedLine = `__KORRELO_UPDATE_DONE__|failed|${sanitizeReason(result.error)}`;
    console.log(failedLine);
    persistMarker(parseMarker(failedLine));
    process.exit(1);
  }

  console.log("");
  console.log("ROLLOUT CONCLUÍDO. Containers de projeto idênticos ao snapshot anterior.");
  const doneLine = "__KORRELO_UPDATE_DONE__|success|";
  console.log(doneLine);
  persistMarker(parseMarker(doneLine));
  process.exit(0);
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error);
  console.error(`erro no rollout: ${message}`);
  // O job não pode ficar "running" eternamente: se o rollout morreu antes do
  // marcador final, o job é finalizado aqui.
  const failedLine = `__KORRELO_UPDATE_DONE__|failed|${sanitizeReason(message)}`;
  console.log(failedLine);
  persistMarker(parseMarker(failedLine));
  process.exit(1);
});
