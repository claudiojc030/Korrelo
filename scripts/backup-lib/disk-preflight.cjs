"use strict";

/**
 * PREFLIGHT DE DISCO.
 *
 * Antes de começar o dump, confere se o filesystem de destino tem espaço
 * suficiente. Sem isso, um banco grande enche o disco no meio do dump e
 * o resultado é um backup TRUNCADO que parece válido.
 *
 * A estimativa é CONSERVADORA de propósito: não existe "tamanho exato do
 * dump" antes de fazer o dump. Usa como referência o tamanho do último
 * backup do mesmo alvo (se existir) + uma margem configurável.
 *
 * IMPORTANTE: esta wave NÃO apaga backup nenhum pra "abrir espaço" -
 * se não tem espaço, o backup falha ANTES de começar, com mensagem clara.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_MARGIN_BYTES = 256 * 1024 * 1024; // 256 MB
const DEFAULT_MIN_FREE_BYTES = 512 * 1024 * 1024; // 512 MB
const ESTIMATE_FACTOR = 1.2; // 20% de folga sobre o último backup

/**
 * Espaço livre (em bytes) do filesystem onde `dirPath` mora.
 * Devolve null quando não dá pra medir (sem `df`, diretório inexistente).
 */
function freeSpaceBytes(dirPath) {
  try {
    const result = spawnSync("df", ["-k", dirPath], { encoding: "utf-8" });
    if (result.status !== 0 || !result.stdout) return null;
    const lines = result.stdout.trim().split("\n");
    if (lines.length < 2) return null;
    const fields = lines[lines.length - 1].trim().split(/\s+/);
    // Filesystem 1024-blocks Used Available Capacity Mounted-on
    const availableKb = Number(fields[3]);
    if (!Number.isFinite(availableKb) || availableKb < 0) return null;
    return availableKb * 1024;
  } catch {
    return null;
  }
}

/**
 * Tamanho do maior backup anterior com o MESMO nome de arquivo.
 * Serve de referência pra estimar o tamanho do dump que vai começar.
 */
function referenceBackupBytes(backupRoot, baseName) {
  if (!backupRoot || !baseName) return 0;
  let entries;
  try {
    entries = fs.readdirSync(backupRoot, { withFileTypes: true });
  } catch {
    return 0;
  }

  let largest = 0;
  for (const entry of entries) {
    const candidate = path.join(backupRoot, entry.name, baseName);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && stat.size > largest) largest = stat.size;
    } catch {
      // esse alvo não tem backup anterior
    }
  }
  return largest;
}

/**
 * Decide se há espaço suficiente pra o dump.
 *
 * @param {object} options
 * @param {string} options.dir            diretório de destino
 * @param {number} [options.referenceBytes] tamanho do último backup (0 se não houver)
 * @param {number} [options.marginBytes]
 * @param {number} [options.minFreeBytes]
 * @returns {{ok: boolean, freeBytes: number|null, requiredBytes: number, message: string}}
 */
function checkDiskSpace(options) {
  const {
    dir,
    referenceBytes = 0,
    marginBytes = DEFAULT_MARGIN_BYTES,
    minFreeBytes = DEFAULT_MIN_FREE_BYTES,
  } = options || {};

  const freeBytes = freeSpaceBytes(dir);
  const estimate = referenceBytes > 0 ? Math.ceil(referenceBytes * ESTIMATE_FACTOR) : 0;
  const requiredBytes = estimate + marginBytes;

  if (freeBytes === null) {
    // Sem medida de disco: não bloqueia o backup (df pode não existir em
    // algum ambiente), mas deixa isso registrado.
    return {
      ok: true,
      freeBytes: null,
      requiredBytes,
      message: "Não foi possível medir o espaço livre (df indisponível); o dump vai em frente.",
    };
  }

  if (freeBytes < requiredBytes || freeBytes < minFreeBytes) {
    const needed = Math.max(requiredBytes, minFreeBytes);
    return {
      ok: false,
      freeBytes,
      requiredBytes: needed,
      message:
        `Espaço insuficiente em ${dir}: ${formatBytes(freeBytes)} livres, ` +
        `são necessários ${formatBytes(needed)} (estimativa do dump + margem). ` +
        "Nenhum backup foi apagado automaticamente - libere espaço e rode de novo.",
    };
  }

  return {
    ok: true,
    freeBytes,
    requiredBytes,
    message: `Espaço livre: ${formatBytes(freeBytes)} (necessário ~${formatBytes(requiredBytes)}).`,
  };
}

/** Formata bytes de forma legível (mensagens de erro pro operador). */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

module.exports = {
  freeSpaceBytes,
  referenceBackupBytes,
  checkDiskSpace,
  formatBytes,
  DEFAULT_MARGIN_BYTES,
  DEFAULT_MIN_FREE_BYTES,
  ESTIMATE_FACTOR,
};
