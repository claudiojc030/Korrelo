#!/usr/bin/env node
/**
 * Ensaio descartável de backup → migrations de staging → falha → restauração.
 *
 * Constrói um banco SQLite de "produção" aplicando todas as migrations do Korrelo
 * EXCETO as três de staging, insere dados de exemplo, faz backup consistente,
 * aplica as três migrations numa CÓPIA, simula corrupção da cópia e restaura.
 *
 * Nunca toca em banco real: tudo fica em --workdir (temporário por padrão).
 *
 * Uso:
 *   node sqlite-restore-drill.mjs --migrations ../apps/api/prisma/migrations [--workdir /tmp/drill]
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { backupDatabase, openForReadOnlyQueries, restoreDatabase, verifyDatabase } from "./lib/sqlite-core.mjs";

const STAGING_MIGRATIONS = [
  "20261115120000_add_staging_config",
  "20261115180000_add_staging_port_leases",
  "20261115200000_add_staging_runs",
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    out[argv[i].slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listMigrations(dir) {
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, "migration.sql")))
    .sort();
}

async function execSql(path, sql) {
  // Escrita SOMENTE no banco descartável do drill.
  const { DatabaseSync } = await import("node:sqlite");
  const writable = new DatabaseSync(path);
  try {
    writable.exec(sql);
  } finally {
    writable.close();
  }
}

async function snapshotSchema(path) {
  const db = await openForReadOnlyQueries(path);
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
    const columns = {};
    for (const table of tables) {
      columns[table] = db
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((row) => row.name)
        .sort();
    }
    return { tables, columns };
  } finally {
    db.close();
  }
}

async function countRows(path, table) {
  const db = await openForReadOnlyQueries(path);
  try {
    return db.prepare(`SELECT count(*) AS n FROM "${table}"`).all()[0]?.n ?? null;
  } finally {
    db.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.migrations) throw new Error("--migrations é obrigatório (diretório prisma/migrations do Korrelo)");
  const migrationsDir = resolve(args.migrations);
  const workdir = args.workdir ? resolve(args.workdir) : mkdtempSync(join(tmpdir(), "korrelo-sqlite-drill-"));
  mkdirSync(workdir, { recursive: true });

  const all = listMigrations(migrationsDir);
  const staging = all.filter((name) => STAGING_MIGRATIONS.some((prefix) => name.startsWith(prefix)));
  const baseline = all.filter((name) => !staging.includes(name));
  if (staging.length !== 3) {
    throw new Error(`esperava 3 migrations de staging em ${migrationsDir}, encontrei ${staging.length}: ${staging.join(", ")}`);
  }

  const liveDb = join(workdir, "korrelo-base.db");
  const copyDb = join(workdir, "korrelo-staging.db");
  const backupFile = join(workdir, "korrelo-base.backup.db");
  const restoredDb = join(workdir, "korrelo-restored.db");
  for (const file of [liveDb, copyDb, backupFile, restoredDb]) {
    if (existsSync(file)) writeFileSync(file, "");
  }
  // começa de um arquivo vazio válido
  const { DatabaseSync } = await import("node:sqlite");
  new DatabaseSync(liveDb).close();

  const checks = [];
  const check = (name, ok, detail = "") => {
    checks.push({ name, ok: Boolean(ok), detail });
    if (!ok) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  };

  // 1. Baseline = produção atual (sem as três migrations de staging).
  for (const name of baseline) {
    await execSql(liveDb, readFileSync(join(migrationsDir, name, "migration.sql"), "utf8"));
  }
  await execSql(
    liveDb,
    `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "checksum" TEXT NOT NULL,
      "finished_at" DATETIME,
      "migration_name" TEXT NOT NULL,
      "logs" TEXT,
      "rolled_back_at" DATETIME,
      "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
      "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
    );`,
  );
  for (const name of baseline) {
    await execSql(
      liveDb,
      `INSERT INTO "_prisma_migrations" ("id","checksum","finished_at","migration_name","started_at","applied_steps_count") VALUES ('id-${name}','x',current_timestamp,'${name}',current_timestamp,1);`,
    );
  }
  await execSql(
    liveDb,
    `INSERT INTO "Project" ("id","name","repoUrl") VALUES ('proj-1','Mesatta','https://example.com/mesatta.git'),('proj-2','Outro','https://example.com/outro.git');`,
  );
  check("baseline aplicado", baseline.length === all.length - 3, `${baseline.length} migrations`);

  const baselineSchema = await snapshotSchema(liveDb);
  const baselineProjects = await countRows(liveDb, "Project");
  check("dados de exemplo inseridos", baselineProjects === 2, String(baselineProjects));
  const sourceHashBefore = sha256(liveDb);

  // 2. Backup consistente do "banco de produção".
  const backup = await backupDatabase(liveDb, backupFile);
  check("backup criado e íntegro", backup.ok === true, backup.issues.join("; "));
  check("backup preserva contagem de migrations", backup.migrations === baseline.length, String(backup.migrations));
  check("origem não foi alterada pelo backup", sha256(liveDb) === sourceHashBefore);

  // 3. Migrations de staging aplicadas SOMENTE na cópia.
  copyFileSync(backupFile, copyDb);
  for (const name of staging) {
    await execSql(copyDb, readFileSync(join(migrationsDir, name, "migration.sql"), "utf8"));
  }
  const migratedSchema = await snapshotSchema(copyDb);
  const NEW_TABLES = ["ProjectStagingConfig", "StagingDependency", "StagingPortLease", "StagingRun", "StagingSecret"];
  for (const table of NEW_TABLES) {
    check(`migration criou ${table}`, migratedSchema.tables.includes(table));
  }
  for (const [table, columns] of Object.entries(baselineSchema.columns)) {
    const after = migratedSchema.columns[table] ?? [];
    const missing = columns.filter((column) => !after.includes(column));
    check(`preservou colunas de ${table}`, missing.length === 0, missing.join(","));
  }
  check("preservou dados de Project após migrations", (await countRows(copyDb, "Project")) === baselineProjects);

  // 4. Falha simulada: corrompe a cópia em uso.
  writeFileSync(copyDb, "isto-nao-e-um-banco-sqlite");
  let corrupted;
  try {
    corrupted = await verifyDatabase(copyDb);
  } catch (error) {
    corrupted = { ok: false, issues: [error instanceof Error ? error.message : String(error)] };
  }
  check("corrupção é detectada", corrupted.ok === false, JSON.stringify(corrupted.issues ?? []));

  // 5. Restauração a partir do backup em caminho novo.
  const restored = await restoreDatabase(backupFile, restoredDb);
  check("restauração íntegra", restored.ok === true, restored.issues.join("; "));
  const restoredSchema = await snapshotSchema(restoredDb);
  check("restauração volta ao schema anterior", !restoredSchema.tables.includes("ProjectStagingConfig"));
  check("restauração preserva dados", (await countRows(restoredDb, "Project")) === baselineProjects);
  check(
    "restauração preserva migrations anteriores",
    restored.migrations === baseline.length,
    `${restored.migrations} vs ${baseline.length}`,
  );

  // 6. Compatibilidade com a versão anterior: consultas do schema legado funcionam.
  const legacy = await openForReadOnlyQueries(restoredDb);
  let legacyOk = false;
  try {
    const rows = legacy
      .prepare("SELECT id, name, repoUrl, status FROM Project ORDER BY id")
      .all();
    legacyOk = rows.length === 2 && rows[0].name === "Mesatta";
  } finally {
    legacy.close();
  }
  check("versão anterior consegue ler o banco restaurado", legacyOk);
  check("origem continua intacta no fim do ensaio", sha256(liveDb) === sourceHashBefore);

  const report = {
    drillAt: new Date().toISOString(),
    workdir,
    migrations: { total: all.length, baseline: baseline.length, staging },
    files: {
      base: { path: liveDb, bytes: statSync(liveDb).size, sha256: sha256(liveDb) },
      backup: { path: backupFile, bytes: statSync(backupFile).size, sha256: sha256(backupFile) },
      restored: { path: restoredDb, bytes: statSync(restoredDb).size, sha256: sha256(restoredDb) },
    },
    restoredVerification: restored,
    checks,
    verdict: checks.every((entry) => entry.ok) ? "PASS" : "FAIL",
  };
  writeFileSync(join(workdir, "drill-report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
