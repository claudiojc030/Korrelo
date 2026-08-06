#!/usr/bin/env node
// Backup diário do banco Core (SQLite ou Postgres, dependendo do DATABASE_URL)
// e dos bancos gerenciados por projeto (containers postgres/mongodb sempre;
// redis só quando o projeto marcou explicitamente como persistente, já que
// por padrão é tratado como cache/fila descartável).
//
// Uso: node scripts/backup.js   (roda a partir de apps/api, ou via scripts/backup.sh)
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
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const run = promisify(execFile);
const MAX_BUFFER = 500 * 1024 * 1024;

const BACKUP_ROOT = process.env.BACKUP_DIR || path.join(os.homedir(), "korrelo-backups");
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 7);

async function backupCoreDatabase(destDir) {
  const databaseUrl = process.env.DATABASE_URL || "file:./dev.db";
  if (databaseUrl.startsWith("file:")) {
    // Caminhos relativos em DATABASE_URL são resolvidos pelo Prisma relativo à
    // pasta do schema.prisma (apps/api/prisma/), não ao cwd. Mesma regra aqui.
    const dbFile = path.resolve(__dirname, "..", "prisma", databaseUrl.replace("file:", ""));
    const dest = path.join(destDir, "core.db");
    try {
      await run("sqlite3", [dbFile, `.backup '${dest}'`], { maxBuffer: MAX_BUFFER });
    } catch {
      // Sem o binário sqlite3 instalado: cópia direta como fallback (menos
      // seguro sob escrita concorrente, mas melhor que não ter backup nenhum).
      await fs.copyFile(dbFile, dest);
    }
    console.log(`Core (SQLite) -> ${dest}`);
  } else if (databaseUrl.startsWith("postgres")) {
    const dest = path.join(destDir, "core.sql");
    const { stdout } = await run("pg_dump", [databaseUrl], { maxBuffer: MAX_BUFFER });
    await fs.writeFile(dest, stdout);
    console.log(`Core (Postgres) -> ${dest}`);
  } else {
    throw new Error(`DATABASE_URL não reconhecido pra backup: ${databaseUrl}`);
  }
}

async function backupProjectUploads(project, destDir) {
  // /app/uploads é o volume nomeado que todo projeto ganha (ver
  // docker-compose-file-builder.ts) pra guardar arquivo enviado por usuário
  // (foto, vídeo) fora do banco. Sobrevive a redeploy mas não é coberto pelos
  // dumps de banco acima, então copia à parte via docker cp direto do
  // container do app (não precisa estar com o volume montado em outro lugar).
  const safeName = project.name.replace(/[^a-z0-9-]+/gi, "-");
  const dest = path.join(destDir, `${safeName}-uploads`);
  try {
    await run("docker", ["cp", `${project.containerName}:/app/uploads`, dest], { maxBuffer: MAX_BUFFER });
    console.log(`${project.name} (uploads) -> ${dest}`);
  } catch {
    // Container sem nada em /app/uploads (path não existe ainda) não é erro,
    // é só um projeto que não guarda arquivo nenhum.
  }
}

async function backupManagedDatabases(prisma, destDir) {
  const projects = await prisma.project.findMany({ include: { managedDatabase: true } });
  const failures = [];

  for (const project of projects) {
    if (project.containerName) {
      await backupProjectUploads(project, destDir);
    }

    const db = project.managedDatabase;
    if (!db || db.type === "custom" || !project.containerName) continue;

    const containerName = `${project.containerName}-db-1`;
    const safeName = project.name.replace(/[^a-z0-9-]+/gi, "-");

    try {
      if (db.type === "postgres") {
        const dest = path.join(destDir, `${safeName}-postgres.sql`);
        const { stdout } = await run(
          "docker",
          ["exec", containerName, "pg_dump", "-U", db.username, db.databaseName],
          { maxBuffer: MAX_BUFFER },
        );
        await fs.writeFile(dest, stdout);
        console.log(`${project.name} (Postgres) -> ${dest}`);
      } else if (db.type === "mongodb") {
        const dest = path.join(destDir, `${safeName}-mongodb.archive`);
        const { stdout } = await run(
          "docker",
          [
            "exec",
            containerName,
            "mongodump",
            "--username",
            db.username,
            "--password",
            db.password,
            "--authenticationDatabase",
            "admin",
            "--archive",
          ],
          { encoding: "buffer", maxBuffer: MAX_BUFFER },
        );
        await fs.writeFile(dest, stdout);
        console.log(`${project.name} (MongoDB) -> ${dest}`);
      } else if (db.type === "redis") {
        if (!db.persistent) {
          console.log(`${project.name} (Redis): pulado (marcado como cache/fila, sem persistência).`);
          continue;
        }
        const dest = path.join(destDir, `${safeName}-redis.rdb`);
        await run("docker", ["exec", containerName, "redis-cli", "-a", db.password, "SAVE"], {
          maxBuffer: MAX_BUFFER,
        });
        await run("docker", ["cp", `${containerName}:/data/dump.rdb`, dest], { maxBuffer: MAX_BUFFER });
        console.log(`${project.name} (Redis) -> ${dest}`);
      }
    } catch (error) {
      console.error(`Falha ao fazer backup de "${project.name}": ${error.message}`);
      failures.push(`${project.name}: ${error.message}`);
    }
  }

  return failures;
}

async function pruneOldBackups() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let entries;
  try {
    entries = await fs.readdir(BACKUP_ROOT, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(BACKUP_ROOT, entry.name);
    const stat = await fs.stat(dirPath);
    if (stat.mtimeMs < cutoff) {
      await fs.rm(dirPath, { recursive: true, force: true });
      console.log(`Backup antigo removido: ${dirPath}`);
    }
  }
}

async function syncOffsite(destDir, stamp) {
  const remote = process.env.BACKUP_RCLONE_REMOTE;
  if (!remote) return;

  try {
    await run("rclone", ["copy", destDir, `${remote}:korrelo-backups/${stamp}`], {
      maxBuffer: MAX_BUFFER,
      timeout: 10 * 60 * 1000,
    });
    console.log(`Enviado pra ${remote}:korrelo-backups/${stamp}`);
  } catch (error) {
    throw new Error(`Falha ao enviar backup pro remote "${remote}": ${error.message}`);
  }
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
  await fs.mkdir(destDir, { recursive: true });
  console.log(`Backup em ${destDir}`);

  const prisma = new PrismaClient();
  let failures = [];
  try {
    await backupCoreDatabase(destDir);
    failures = await backupManagedDatabases(prisma, destDir);
  } finally {
    await prisma.$disconnect();
  }

  await pruneOldBackups();
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
