#!/usr/bin/env node
/**
 * Korrelo — ferramenta de backup/verificação/restauração do SQLite.
 *
 * REGRAS:
 *  - o banco de ORIGEM é aberto somente leitura;
 *  - `backup` nunca sobrescreve um arquivo existente sem `--force`;
 *  - `restore` só escreve no caminho `--to` informado (use cópia descartável);
 *  - nenhum comando toca em containers, serviços, env ou outros bancos.
 *
 * Uso:
 *   node korrelo-sqlite-backup.mjs path
 *   node korrelo-sqlite-backup.mjs verify --db /var/lib/korrelo/korrelo.db
 *   node korrelo-sqlite-backup.mjs backup --db <origem> --out /root/backup/korrelo-<data>.db
 *   node korrelo-sqlite-backup.mjs restore --backup <arquivo> --to /tmp/drill/korrelo.db
 */
import { existsSync, statSync } from "node:fs";
import { backupDatabase, restoreDatabase, verifyDatabase } from "./lib/sqlite-core.mjs";

const CANDIDATES = [
  process.env.KORRELO_DB_PATH,
  process.env.DATABASE_URL?.startsWith("file:") ? process.env.DATABASE_URL.replace(/^file:/, "") : null,
  "/var/lib/korrelo/korrelo.db",
  "/opt/korrelo/korrelo.db",
  "/opt/korrelo/apps/api/prisma/prod.db",
  "/opt/korrelo/apps/api/prisma/dev.db",
  "./prisma/prod.db",
].filter(Boolean);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function emit(payload, asText) {
  if (asText) {
    for (const [key, value] of Object.entries(payload)) {
      process.stdout.write(`${key}: ${typeof value === "object" ? JSON.stringify(value) : value}\n`);
    }
  } else {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? "path";
  const text = args.text === true;

  if (command === "path") {
    const candidates = CANDIDATES.map((path) => {
      const exists = existsSync(path);
      return { path, exists, bytes: exists ? statSync(path).size : null };
    }).filter((entry, index, all) => all.findIndex((other) => other.path === entry.path) === index);
    emit({ command, candidates, note: "nada foi aberto; apenas stat" }, text);
    return 0;
  }

  if (command === "verify") {
    if (!args.db) throw new Error("--db é obrigatório");
    emit({ command, ...(await verifyDatabase(args.db)) }, text);
    return 0;
  }

  if (command === "backup") {
    if (!args.db || !args.out) throw new Error("--db e --out são obrigatórios");
    emit({ command, ...(await backupDatabase(args.db, args.out, { force: args.force === true })) }, text);
    return 0;
  }

  if (command === "restore") {
    if (!args.backup || !args.to) throw new Error("--backup e --to são obrigatórios");
    emit({ command, ...(await restoreDatabase(args.backup, args.to, { force: args.force === true })) }, text);
    return 0;
  }

  throw new Error(`comando desconhecido: ${command} (path|verify|backup|restore)`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
