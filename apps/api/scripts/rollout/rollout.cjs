#!/usr/bin/env node
"use strict";

/**
 * CLI do rollout do Korrelo.
 *
 *   node apps/api/scripts/rollout/rollout.cjs --plan     # só o plano teórico
 *   node apps/api/scripts/rollout/rollout.cjs             # dry-run REAL (read-only)
 *   node apps/api/scripts/rollout/rollout.cjs --apply     # rollout de verdade
 *
 * Modos:
 *  - --plan: imprime o plano. NÃO fala com Docker nem com o banco.
 *  - (sem argumentos): DRY-RUN REAL - executa todas as verificações somente
 *    leitura (git, core, host, health, snapshot real dos projetos) e não
 *    escreve NADA (sem lock, sem drain, sem backup, sem arquivo de status).
 *  - --apply: o rollout de verdade (com backup, migration, build e restart
 *    do Core).
 */

const fs = require("node:fs");
const path = require("node:path");

const { run } = require("./lib/command-runner.cjs");
const { planRollout, executeRollout, defaultConfig } = require("./lib/rollout.cjs");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const CONFIG_PATH = path.join(__dirname, "rollout.config.json");

function loadConfig() {
  const base = defaultConfig(REPO_ROOT);
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    file = {};
  }
  return {
    ...base,
    ...file,
    repoRoot: REPO_ROOT,
    coreDbPath: path.join(REPO_ROOT, "apps", "api", "prisma", "dev.db"),
    coreEnvPath: path.join(REPO_ROOT, "apps", "api", ".env"),
    coreBackupDir: path.join(require("node:os").homedir(), "korrelo-backups"),
  };
}

function printPlan(plan) {
  console.log("=== PLANO DE ROLLOUT DO KORRELO (nada será executado) ===");
  console.log(`branch:              ${plan.git.branch}`);
  console.log(`commit atual:        ${plan.git.commit}`);
  console.log(`working tree limpo:  ${plan.git.dirty ? "NÃO" : "sim"}`);
  if (plan.git.dirty) {
    console.log("  tracked modificados:");
    for (const file of plan.git.trackedModified) console.log(`    ${file}`);
    console.log("  untracked:");
    for (const file of plan.git.untracked) console.log(`    ${file}`);
  }
  console.log(`backup do Core:      ${plan.backup.wouldCreate} (${plan.backup.method})`);
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
  console.log(`migrations no repo:   ${report.core.migrations.join(", ") || "(nenhuma)"}`);

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
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const planOnly = args.includes("--plan");
  const config = loadConfig();

  // ------------------------------------------------------------------ --plan
  if (planOnly) {
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
  if (!apply) {
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
      console.log(`__KORRELO_UPDATE_STEP__|${percent}|${label}`);
    },
  });
  if (!result.ok) {
    console.error("");
    console.error(`ROLLOUT FALHOU: ${result.error}`);
    if (result.state && result.state.backupPath) {
      console.error(`Backup do Core criado em: ${result.state.backupPath}`);
    }
    if (result.rollback) {
      console.error(
        result.rollback.ok
          ? "Rollback do Core concluído (os projetos NÃO foram tocados)."
          : `Rollback do Core falhou: ${result.rollback.reason}`,
      );
    }
    console.log(`__KORRELO_UPDATE_DONE__|failed|${String(result.error).slice(0, 200)}`);
    process.exit(1);
  }

  console.log("");
  console.log("ROLLOUT CONCLUÍDO. Containers de projeto idênticos ao snapshot anterior.");
  console.log("__KORRELO_UPDATE_DONE__|success|");
  process.exit(0);
}

main().catch((error) => {
  console.error(`erro no rollout: ${error && error.message ? error.message : error}`);
  process.exit(1);
});
