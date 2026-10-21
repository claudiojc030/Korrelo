"use strict";

/**
 * ARQUIVO DE PROGRESSO DO BACKUP.
 *
 * O painel acompanha o backup pelo arquivo de progresso (e não por
 * "a última vez que o log foi mexido"). Isso elimina o falso positivo
 * clássico: um dump de 2 horas que continua escrevendo NÃO pode ser
 * marcado como "morto" só porque passou 30 minutos.
 *
 * Campos: jobId, phase, bytesWritten, startedAt, lastProgressAt, pid.
 */

const fs = require("node:fs");
const path = require("node:path");
const { writeJsonAtomic, readJson } = require("./backup-file.cjs");

const THROTTLE_MS = 2_000;

/**
 * Cria um escritor de progresso (com throttle - escrever a cada chunk
 * de dump Would ser desperdício de I/O).
 *
 * @param {object} options
 * @param {string} options.filePath
 * @param {string} [options.jobId]
 * @returns {{update: (patch: object) => void, close: (patch?: object) => void, filePath: string}}
 */
function createProgressWriter(options) {
  const { filePath, jobId = null } = options || {};

  const state = {
    jobId,
    phase: "starting",
    bytesWritten: 0,
    startedAt: Date.now(),
    lastProgressAt: Date.now(),
    pid: process.pid,
  };

  let lastWriteAt = 0;
  let closed = false;

  const write = (patch) => {
    if (closed || !filePath) return;
    Object.assign(state, patch || {});
    state.lastProgressAt = Date.now();
    try {
      writeJsonAtomic(filePath, state);
    } catch {
      // Progresso é best effort: falhar aqui não pode derrubar o backup.
    }
  };

  return {
    filePath,
    update(patch) {
      if (closed || !filePath) return;
      const now = Date.now();
      if (now - lastWriteAt < THROTTLE_MS) return;
      lastWriteAt = now;
      write(patch);
    },
    close(patch) {
      if (closed) return;
      write(patch);
      closed = true;
    },
  };
}

/** Lê o arquivo de progresso (null se não existir/corrompido). */
function readProgress(filePath) {
  if (!filePath) return null;
  const data = readJson(filePath);
  if (!data || typeof data !== "object") return null;
  return data;
}

/** Remove o arquivo de progresso (fim de job). */
function clearProgress(filePath) {
  if (!filePath) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    /* best effort */
  }
}

/** Cria o diretório do arquivo de progresso. */
function ensureProgressDir(filePath) {
  if (!filePath) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  } catch {
    /* best effort */
  }
}

module.exports = {
  createProgressWriter,
  readProgress,
  clearProgress,
  ensureProgressDir,
  THROTTLE_MS,
};
