"use strict";

/**
 * Backup consistente do banco Core (SQLite) antes de qualquer migration.
 *
 * Regras:
 * - o backup é feito com `sqlite3 .backup` (cópia consistente, mesmo com o
 *   banco sendo usado) - NUNCA um `cp` simples (pode capturar um arquivo
 *   pela metade);
 * - se o `sqlite3` não estiver disponível, ABORTA com instrução clara
 *   (nunca faz backup potencialmente inconsistente);
 * - o backup é validado (existe, não está vazio e o `PRAGMA integrity_check`
 *   responde "ok") ANTES de qualquer coisa continuar;
 * - o nome é core-pre-update-YYYYMMDD-HHMMSS.db;
 * - o backup fica FORA do diretório do banco;
 * - um backup anterior NUNCA é sobrescrito.
 */

const fs = require("node:fs");
const path = require("node:path");

function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * @param {object} options
 * @param {string} options.dbPath       caminho do dev.db
 * @param {string} options.backupDir     diretório de destino (fora do dir do banco)
 * @param {(cmd:string,args:string[],opts?:object)=>Promise<{code:number,stdout:string,stderr:string,timedOut?:boolean}>} options.run
 * @param {Date} [options.now]
 */
async function backupCoreDatabase({ dbPath, backupDir, run, now = new Date() }) {
  const problems = [];

  if (!fs.existsSync(dbPath)) {
    return {
      ok: false,
      path: null,
      bytes: 0,
      method: null,
      problems: [`banco do Core não encontrado: ${dbPath}`],
    };
  }

  // Acesso ao banco: precisa ser legível (e gravável pelo usuário do Core).
  try {
    fs.accessSync(dbPath, fs.constants.R_OK);
  } catch {
    return {
      ok: false,
      path: null,
      bytes: 0,
      method: null,
      problems: [`sem permissão de leitura no banco do Core: ${dbPath}`],
    };
  }

  // O sqlite3 precisa existir (o setup-vps.sh instala).
  const sqliteVersion = await run("sqlite3", ["--version"], { timeoutMs: 5_000 });
  if (sqliteVersion.code !== 0) {
    return {
      ok: false,
      path: null,
      bytes: 0,
      method: null,
      problems: [
        "sqlite3 não está disponível - instale com: sudo apt-get install -y sqlite3",
        "(o rollout aborta aqui de propósito: sem backup consistente, não se aplica migration)",
      ],
    };
  }

  fs.mkdirSync(backupDir, { recursive: true });

  const baseName = `core-pre-update-${timestamp(now)}.db`;
  let destination = path.join(backupDir, baseName);
  // Nunca sobrescrever um backup anterior.
  let suffix = 1;
  while (fs.existsSync(destination)) {
    destination = path.join(backupDir, `${baseName.replace(/\.db$/, "")}-${suffix}.db`);
    suffix += 1;
  }

  const backupResult = await run("sqlite3", [dbPath, `.backup '${destination}'`], { timeoutMs: 120_000 });
  if (backupResult.code !== 0) {
    problems.push(`falha no backup do banco: ${backupResult.stderr.trim() || "erro desconhecido"}`);
    return { ok: false, path: destination, bytes: 0, method: "sqlite3 .backup", problems };
  }

  // Validação: existe, não está vazio e o banco está íntegro.
  let bytes = 0;
  try {
    bytes = fs.statSync(destination).size;
  } catch {
    problems.push("o arquivo de backup não foi criado");
  }
  if (bytes === 0) {
    problems.push("o arquivo de backup está vazio");
  }

  const integrity = await run("sqlite3", [destination, "PRAGMA integrity_check;"], { timeoutMs: 60_000 });
  const integrityOk = integrity.code === 0 && integrity.stdout.trim() === "ok";
  if (!integrityOk) {
    problems.push(`integridade do backup não confirmada: ${integrity.stdout.trim() || integrity.stderr.trim()}`);
  }

  return {
    ok: problems.length === 0,
    path: destination,
    bytes,
    method: "sqlite3 .backup",
    problems,
  };
}

module.exports = { backupCoreDatabase, timestamp };
