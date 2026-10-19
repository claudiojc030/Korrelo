#!/usr/bin/env node
"use strict";

/**
 * CLI do rollout do Korrelo.
 *
 *   node apps/api/scripts/rollout/rollout.cjs            # dry-run (padrão)
 *   node apps/api/scripts/rollout/rollout.cjs --apply    # executa de verdade
 *   node apps/api/scripts/rollout/rollout.cjs --plan     # só imprime o plano
 *
 * O padrão é DRY-RUN: nada é escrito, nenhum container é tocado, nenhuma
 * migration é aplicada, o PM2 não é reiniciado.
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

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const planOnly = args.includes("--plan");
  const config = loadConfig();

  if (planOnly || !apply) {
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
    console.log("DRY-RUN: nada foi executado. Use --apply para rodar de verdade.");
    process.exit(0);
  }

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
