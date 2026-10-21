"use strict";

/**
 * RETENÇÃO DE BACKUPS.
 *
 * nesta wave o redesign completo da retenção fica pra W5. O que já é
 * garantido aqui:
 * - o backup MAIS RECENTE nunca é removido;
 * - uma pasta com dump em andamento (arquivo .tmp de job vivo) nunca é
 *   removida;
 * - o backup pré-restore em andamento nunca é removido;
 * - nada é apagado pra "abrir espaço" (isso é do preflight de disco).
 */

const fs = require("node:fs/promises");
const path = require("node:path");

const fileLib = require("./backup-file.cjs");

/** A pasta tem algum .tmp (dump em andamento)? */
async function hasActiveTempFile(dirPath) {
  try {
    const files = await fs.readdir(dirPath);
    return files.some((name) => fileLib.isTempFileName(name));
  } catch {
    return false;
  }
}

/**
 * Remove backups antigos.
 *
 * @param {object} options
 * @param {string} options.root          diretório com as pastas de backup
 * @param {number} options.retentionDays
 * @param {(message: string) => void} [options.onLog]
 * @returns {Promise<{removed: string[], preserved: string[]}>}
 */
async function pruneOldBackups(options) {
  const { root, retentionDays = 7, onLog = () => {} } = options || {};
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const removed = [];
  const preserved = [];

  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return { removed, preserved };
  }

  const directories = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(root, entry.name);
    try {
      const stat = await fs.stat(dirPath);
      directories.push({ dirPath, mtimeMs: stat.mtimeMs });
    } catch {
      // pasta sumiu no meio do scan
    }
  }

  directories.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (let index = 0; index < directories.length; index++) {
    const { dirPath, mtimeMs } = directories[index];

    // O backup mais recente nunca é removido.
    if (index === 0) continue;
    if (mtimeMs >= cutoff) continue;

    // Dump em andamento (arquivo .tmp de job vivo): não mexe.
    if (await hasActiveTempFile(dirPath)) {
      preserved.push(dirPath);
      onLog(`Backup antigo preservado (dump em andamento): ${dirPath}`);
      continue;
    }

    await fs.rm(dirPath, { recursive: true, force: true });
    removed.push(dirPath);
    onLog(`Backup antigo removido: ${dirPath}`);
  }

  return { removed, preserved };
}

module.exports = {
  pruneOldBackups,
  hasActiveTempFile,
};
