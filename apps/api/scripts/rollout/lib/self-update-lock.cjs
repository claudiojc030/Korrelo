"use strict";

/**
 * Lock de self-update / rollout.
 *
 * Arquivo separado do lock do worker de deploy (`deploy-worker.lock`) - são
 * coisas diferentes:
 *   - deploy-worker.lock: garante UM build por vez;
 *   - self-update.lock: garante UM rollout do Korrelo por vez.
 *
 * Criação atômica (O_EXCL), com PID e timestamp. Lock órfão (processo morto
 * ou timeout) é recuperado automaticamente.
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_LOCK_NAME = "self-update.lock";
const ORPHANED_TIMEOUT_MS = 30 * 60 * 1000;

function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function defaultLockPath(home = require("node:os").homedir()) {
  return path.join(home, ".korrelo", DEFAULT_LOCK_NAME);
}

/**
 * Tenta pegar o lock.
 * @returns {{ acquired: boolean, reason: string|null, path: string }}
 */
function acquireLock({ lockPath = defaultLockPath(), pid = process.pid, now = Date.now(), timeoutMs = ORPHANED_TIMEOUT_MS } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, JSON.stringify({ pid, acquiredAt: now, startedAt: new Date(now).toISOString() }));
      fs.closeSync(fd);
      return { acquired: true, reason: null, path: lockPath };
    } catch (error) {
      if (error && error.code !== "EEXIST") {
        return { acquired: false, reason: `não foi possível criar o lock: ${error.message}`, path: lockPath };
      }
      if (!isOrphaned(lockPath, now, timeoutMs)) {
        return { acquired: false, reason: "outro rollout do Korrelo já está em andamento", path: lockPath };
      }
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        return { acquired: false, reason: "lock órfão não pôde ser removido", path: lockPath };
      }
    }
  }

  return { acquired: false, reason: "não foi possível pegar o lock", path: lockPath };
}

function isOrphaned(lockPath, now = Date.now(), timeoutMs = ORPHANED_TIMEOUT_MS) {
  try {
    const stat = fs.statSync(lockPath);
    if (now - stat.mtimeMs > timeoutMs) return true;
    const content = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    return !isProcessAlive(Number(content.pid));
  } catch {
    return true;
  }
}

function releaseLock(lockPath) {
  try {
    fs.rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf-8"));
  } catch {
    return null;
  }
}

module.exports = {
  acquireLock,
  releaseLock,
  isOrphaned,
  readLock,
  defaultLockPath,
  DEFAULT_LOCK_NAME,
  ORPHANED_TIMEOUT_MS,
};
