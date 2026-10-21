#!/usr/bin/env node
"use strict";

/**
 * CLI de EXPORTAÇÃO de banco (usado por scripts/export-database.sh).
 *
 * Mantém o contrato antigo com o painel:
 *   __KORRELO_DBEXPORT_STEP__|<percentual>|<label>
 *   __KORRELO_DBEXPORT_DONE__|success
 *   __KORRELO_DBEXPORT_DONE__|failed|<mensagem>
 *
 * As credenciais chegam por variável de ambiente (nunca por argumento),
 * e o dump em si é feito pelo motor único (dump.cjs): streaming direto
 * pro arquivo, temp + rename atômico, sha256 + manifesto, lock por
 * banco e preflight de disco.
 */

const { dumpDatabase } = require("./dump.cjs");
const { runProcess } = require("./process-runner.cjs");

const STEP_MARKER = "__KORRELO_DBEXPORT_STEP__";
const DONE_MARKER = "__KORRELO_DBEXPORT_DONE__";

function step(percent, label) {
  process.stdout.write(`${STEP_MARKER}|${percent}|${label}\n`);
}

function done(outcome, message) {
  process.stdout.write(`${DONE_MARKER}|${outcome}${message ? `|${message}` : ""}\n`);
}

async function main() {
  const containerName = process.env.CONTAINER_NAME;
  const dbType = process.env.DB_TYPE;
  const outFile = process.env.OUT_FILE;

  if (!containerName || !dbType || !outFile) {
    done("failed", "Variáveis obrigatórias ausentes (CONTAINER_NAME, DB_TYPE, OUT_FILE).");
    return 1;
  }

  const jobId = process.env.KORRELO_JOB_ID || undefined;
  const reason = process.env.KORRELO_REASON || "manual";

  step(10, "Exportando banco de dados");

  const result = await dumpDatabase({
    dbType,
    containerName,
    username: process.env.DB_USERNAME || null,
    password: process.env.DB_PASSWORD || null,
    databaseName: process.env.DB_NAME || null,
    outFile,
    reason,
    projectId: process.env.KORRELO_PROJECT_ID || null,
    serviceName: process.env.KORRELO_SERVICE || null,
    jobId,
    progressFile: process.env.KORRELO_PROGRESS_FILE || null,
    lockDir: process.env.KORRELO_LOCK_DIR || undefined,
    backupRoot: process.env.KORRELO_BACKUP_ROOT || process.env.BACKUP_DIR || null,
    writeManifest: process.env.KORRELO_WRITE_MANIFEST !== "0",
    onLog: (message) => process.stdout.write(`${message}\n`),
  });

  if (!result.ok) {
    done("failed", result.error || "Falha ao exportar o banco.");
    return 1;
  }

  step(80, "Enviando pro armazenamento externo (se configurado)");
  const remote = process.env.BACKUP_RCLONE_REMOTE;
  if (remote) {
    const copy = await runProcess({
      command: "rclone",
      args: ["copy", outFile, `${remote}:korrelo-backups/exports/`],
      inactivityTimeoutMs: 10 * 60 * 1000,
      maxTimeoutMs: 10 * 60 * 1000,
    });
    if (copy.error || copy.code !== 0) {
      process.stdout.write("Aviso: falha ao enviar pro remote rclone, o arquivo continua disponível pra download.\n");
    }
  }

  step(100, "Exportação concluída");
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
