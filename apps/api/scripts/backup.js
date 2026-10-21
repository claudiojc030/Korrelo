#!/usr/bin/env node
// Backup diário do banco Core (SQLite ou Postgres, dependendo do DATABASE_URL)
// e dos bancos gerenciados por projeto (containers postgres/mongodb sempre;
// redis só quando o projeto marcou explicitamente como persistente, já que
// por padrão é tratado como cache/fila descartável).
//
// Uso: node scripts/backup.js   (roda a partir de apps/api, ou via scripts/backup.sh)
//
// O dump em si é feito pelo motor ÚNICO (scripts/backup-lib/dump.cjs), o mesmo
// usado pelo botão "Fazer backup agora" e pelo restore. Garantias do motor:
// stdout do dump vai direto pro arquivo (RAM constante), o arquivo final só
// aparece depois de tudo dar certo (temp + rename atômico), sha256 + manifesto
// são gravados junto, existe lock por banco (cron x manual não se atropelam) e
// há preflight de disco antes de começar.
//
// Env opcionais:
//   BACKUP_DIR                (padrão ~/korrelo-backups)
//   BACKUP_RETENTION_DAYS     (padrão 7)
//   BACKUP_ALERT_NTFY_TOPIC   se definido, manda um push via ntfy.sh quando o backup falha
//   BACKUP_RCLONE_REMOTE      se definido (ex: "gdrive"), copia o backup do dia pra esse
//                             remote configurado via `rclone config` (Google Drive, S3, etc.)
"use strict";

require("dotenv/config");
const { PrismaClient } = require("@prisma/client");
const os = require("node:os");
const path = require("node:path");

const { dumpCoreDatabase } = require("../../../scripts/backup-lib/dump.cjs");
const { backupProjects } = require("../../../scripts/backup-lib/project-backup.cjs");
const { pruneOldBackups } = require("../../../scripts/backup-lib/retention.cjs");
const { runProcess } = require("../../../scripts/backup-lib/process-runner.cjs");
const fileLib = require("../../../scripts/backup-lib/backup-file.cjs");

const BACKUP_ROOT = process.env.BACKUP_DIR || path.join(os.homedir(), "korrelo-backups");
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 7);

async function backupCoreDatabase(destDir) {
  const databaseUrl = process.env.DATABASE_URL || "file:./dev.db";
  const dest = path.join(destDir, databaseUrl.startsWith("file:") ? "core.db" : "core.sql");

  // Caminhos relativos em DATABASE_URL são resolvidos pelo Prisma relativo à
  // pasta do schema.prisma (apps/api/prisma/), não ao cwd. Mesma regra aqui.
  const sqliteFile = databaseUrl.startsWith("file:")
    ? path.resolve(__dirname, "..", "prisma", databaseUrl.replace("file:", ""))
    : null;

  const result = await dumpCoreDatabase({
    databaseUrl,
    outFile: dest,
    sqliteFile,
    reason: "cron",
    onLog: (message) => console.log(message),
  });

  if (!result.ok) {
    throw new Error(result.error || "Falha ao fazer backup do banco do Core.");
  }
  console.log(`Core -> ${dest} (${result.bytes} bytes)`);
  return result;
}

async function backupManagedDatabases(prisma, destDir) {
  const projects = await prisma.project.findMany({ include: { managedDatabases: true } });
  const { failures } = await backupProjects(projects, {
    destDir,
    backupRoot: BACKUP_ROOT,
    reason: "cron",
    onLog: (message) => console.log(message),
  });
  return failures;
}

/**
 * Retenção (simplificada nesta wave).
 *
 * Regras garantidas:
 * - nunca apaga o backup mais recente;
 * - nunca apaga uma pasta com dump em andamento (.tmp de job vivo);
 * - nunca apaga a pasta do backup pré-restore em andamento.
 *
 * O redesign completo da retenção (W5) fica pra depois.
 */
async function pruneBackups() {
  await pruneOldBackups({
    root: BACKUP_ROOT,
    retentionDays: RETENTION_DAYS,
    onLog: (message) => console.log(message),
  });
}

async function syncOffsite(destDir, stamp) {
  const remote = process.env.BACKUP_RCLONE_REMOTE;
  if (!remote) return;

  const result = await runProcess({
    command: "rclone",
    args: ["copy", destDir, `${remote}:korrelo-backups/${stamp}`],
    inactivityTimeoutMs: 10 * 60 * 1000,
    maxTimeoutMs: 10 * 60 * 1000,
  });

  if (result.error || result.code !== 0) {
    throw new Error(`Falha ao enviar backup pro remote "${remote}": ${result.stderr || result.error?.message || "erro desconhecido"}`);
  }
  console.log(`Enviado pra ${remote}:korrelo-backups/${stamp}`);
}

async function notifyFailure(message) {
  const topic = process.env.BACKUP_ALERT_NTFY_TOPIC;
  if (!topic) return;

  try {
    await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers: { Title: "Korrelo: backup falhou" },
      body: message.slice(0, 1000),
    });
  } catch (error) {
    // Não deixa uma falha de rede na notificação mascarar o motivo real do backup ter falhado.
    console.error(`Falha ao mandar alerta via ntfy.sh: ${error.message}`);
  }
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destDir = path.join(BACKUP_ROOT, stamp);
  fileLib.ensureDir(destDir);
  console.log(`Backup em ${destDir}`);

  const prisma = new PrismaClient();
  let failures = [];
  try {
    await backupCoreDatabase(destDir);
    failures = await backupManagedDatabases(prisma, destDir);
  } finally {
    await prisma.$disconnect();
  }

  await pruneBackups();
  await syncOffsite(destDir, stamp);

  if (failures.length > 0) {
    throw new Error(`Backup de ${stamp} com falhas:\n${failures.join("\n")}`);
  }
}

main().catch(async (error) => {
  console.error(error);
  await notifyFailure(`Backup falhou: ${error.message}`);
  process.exit(1);
});
