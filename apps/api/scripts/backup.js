#!/usr/bin/env node
// Backup diário do banco Core (SQLite ou Postgres, dependendo do DATABASE_URL)
// e dos bancos gerenciados por projeto (containers postgres/mongodb). Redis é
// pulado de propósito — geralmente é cache/fila, não dado que precisa persistir.
//
// Uso: node scripts/backup.js   (roda a partir de apps/api, ou via scripts/backup.sh)
// Env opcionais: BACKUP_DIR (padrão ~/forgedesk-backups), BACKUP_RETENTION_DAYS (padrão 7)
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

const BACKUP_ROOT = process.env.BACKUP_DIR || path.join(os.homedir(), "forgedesk-backups");
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 7);

async function backupCoreDatabase(destDir) {
  const databaseUrl = process.env.DATABASE_URL || "file:./dev.db";
  if (databaseUrl.startsWith("file:")) {
    // Caminhos relativos em DATABASE_URL são resolvidos pelo Prisma relativo à
    // pasta do schema.prisma (apps/api/prisma/), não ao cwd — mesma regra aqui.
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
    console.warn(`DATABASE_URL não reconhecido pra backup: ${databaseUrl}`);
  }
}

async function backupManagedDatabases(prisma, destDir) {
  const projects = await prisma.project.findMany({ include: { managedDatabase: true } });

  for (const project of projects) {
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
        console.log(`${project.name} (Redis) — pulado (cache/fila, não costuma precisar de backup).`);
      }
    } catch (error) {
      console.error(`Falha ao fazer backup de "${project.name}": ${error.message}`);
    }
  }
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

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destDir = path.join(BACKUP_ROOT, stamp);
  await fs.mkdir(destDir, { recursive: true });
  console.log(`Backup em ${destDir}`);

  const prisma = new PrismaClient();
  try {
    await backupCoreDatabase(destDir);
    await backupManagedDatabases(prisma, destDir);
  } finally {
    await prisma.$disconnect();
  }

  await pruneOldBackups();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
