#!/usr/bin/env node
"use strict";

/**
 * CLI de RESTAURAÇÃO de banco (usado por scripts/restore-database.sh).
 *
 * Mantém o contrato antigo com o painel:
 *   __KORRELO_DBRESTORE_STEP__|<percentual>|<label>
 *   __KORRELO_DBRESTORE_DONE__|success
 *   __KORRELO_DBRESTORE_DONE__|failed|<mensagem>
 *
 * O restore é DESTRUTIVO, então o motor (restore.cjs) só chega no
 * `--drop`/`DROP SCHEMA` depois de validar o arquivo (tamanho + sha256)
 * e de criar um backup de segurança do estado atual. Se o backup de
 * segurança falhar, o restore é abortado sem tocar no banco.
 */

const { restoreDatabase } = require("./restore.cjs");

const STEP_MARKER = "__KORRELO_DBRESTORE_STEP__";
const DONE_MARKER = "__KORRELO_DBRESTORE_DONE__";

function step(percent, label) {
  process.stdout.write(`${STEP_MARKER}|${percent}|${label}\n`);
}

function done(outcome, message) {
  process.stdout.write(`${DONE_MARKER}|${outcome}${message ? `|${message}` : ""}\n`);
}

async function main() {
  const containerName = process.env.CONTAINER_NAME;
  const dbType = process.env.DB_TYPE;
  const inFile = process.env.IN_FILE;

  if (!containerName || !dbType || !inFile) {
    done("failed", "Variáveis obrigatórias ausentes (CONTAINER_NAME, DB_TYPE, IN_FILE).");
    return 1;
  }

  step(10, "Validando o backup antes de restaurar");

  const result = await restoreDatabase({
    dbType,
    containerName,
    username: process.env.DB_USERNAME || null,
    password: process.env.DB_PASSWORD || null,
    databaseName: process.env.DB_NAME || null,
    inFile,
    preRestoreDir: process.env.KORRELO_PRE_RESTORE_DIR || null,
    jobId: process.env.KORRELO_JOB_ID || undefined,
    projectId: process.env.KORRELO_PROJECT_ID || null,
    serviceName: process.env.KORRELO_SERVICE || null,
    progressFile: process.env.KORRELO_PROGRESS_FILE || null,
    onLog: (message) => process.stdout.write(`${message}\n`),
    onStep: (percent, label) => step(percent, label),
  });

  if (!result.ok) {
    done("failed", result.error || "Falha ao restaurar o banco.");
    return 1;
  }

  step(100, "Restauração concluída");
  done("success");
  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    done("failed", error && error.message ? error.message : String(error));
    process.exit(1);
  });
