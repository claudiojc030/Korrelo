/**
 * Núcleo de backup/verificação/restauração do SQLite do Korrelo.
 *
 * Somente LEITURA no banco de origem. Escritas acontecem apenas no destino
 * informado pelo operador (backup novo ou cópia descartável de drill).
 *
 * O backup usa a API de backup online do SQLite (`node:sqlite.backup`), que é
 * consistente mesmo com WAL e conexões ativas — não é `cp` do arquivo.
 */
import { copyFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";

async function loadSqlite() {
  try {
    return await import("node:sqlite");
  } catch (error) {
    throw new Error(
      "node:sqlite indisponível. Rode com `node --experimental-sqlite` (Node 22) ou use sqlite3 >= 3.27 com `.backup`.",
    );
  }
}

function open(path, { readOnly = false } = {}) {
  // Import é dinâmico para manter o erro acima legível em Node sem o módulo.
  return loadSqlite().then(({ DatabaseSync }) => {
    try {
      return new DatabaseSync(path, { readOnly });
    } catch {
      return new DatabaseSync(path);
    }
  });
}

function queryAll(db, sql) {
  return db.prepare(sql).all();
}

function tableNames(db) {
  return queryAll(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(
    (row) => row.name,
  );
}

export async function verifyDatabase(path) {
  if (!existsSync(path)) return { ok: false, issues: ["arquivo não existe"], path };
  const db = await open(path, { readOnly: true });
  try {
    const integrity = queryAll(db, "PRAGMA integrity_check").map((row) => Object.values(row)[0]);
    const quick = queryAll(db, "PRAGMA quick_check").map((row) => Object.values(row)[0]);
    const foreignKeys = queryAll(db, "PRAGMA foreign_key_check");
    const tables = tableNames(db);
    let migrations = null;
    if (tables.includes("_prisma_migrations")) {
      migrations = queryAll(db, "SELECT count(*) AS n FROM _prisma_migrations")[0]?.n ?? null;
    }
    const pageCount = queryAll(db, "PRAGMA page_count")[0]?.page_count ?? null;
    const pageSize = queryAll(db, "PRAGMA page_size")[0]?.page_size ?? null;
    const issues = [];
    if (integrity.length !== 1 || integrity[0] !== "ok") issues.push(`integrity_check: ${integrity.join("; ")}`);
    if (quick.length !== 1 || quick[0] !== "ok") issues.push(`quick_check: ${quick.join("; ")}`);
    if (foreignKeys.length > 0) issues.push(`foreign_key_check: ${foreignKeys.length} violação(ões)`);
    return {
      ok: issues.length === 0,
      issues,
      path,
      bytes: statSync(path).size,
      tables: tables.length,
      migrations,
      pageCount,
      pageSize,
      walMode: queryAll(db, "PRAGMA journal_mode").map((row) => Object.values(row)[0])[0] ?? null,
    };
  } finally {
    db.close();
  }
}

export async function backupDatabase(sourcePath, targetPath, { force = false } = {}) {
  if (!existsSync(sourcePath)) throw new Error(`banco de origem não existe: ${sourcePath}`);
  if (existsSync(targetPath) && !force) {
    throw new Error(`destino já existe (recusando sobrescrever): ${targetPath}`);
  }
  if (existsSync(targetPath)) rmSync(targetPath);
  const source = await open(sourcePath, { readOnly: true });
  try {
    const { backup } = await loadSqlite();
    await backup(source, targetPath);
  } finally {
    source.close();
  }
  const verification = await verifyDatabase(targetPath);
  return { sourcePath, targetPath, ...verification };
}

export async function restoreDatabase(backupPath, targetPath, { force = false } = {}) {
  const verification = await verifyDatabase(backupPath);
  if (!verification.ok) throw new Error(`backup inválido: ${verification.issues.join("; ")}`);
  if (existsSync(targetPath) && !force) {
    throw new Error(`destino já existe (recusando sobrescrever): ${targetPath}`);
  }
  const temp = `${targetPath}.restore-${Date.now()}.tmp`;
  copyFileSync(backupPath, temp);
  renameSync(temp, targetPath);
  return { backupPath, targetPath, ...(await verifyDatabase(targetPath)) };
}

export async function openForReadOnlyQueries(path) {
  return open(path, { readOnly: true });
}
