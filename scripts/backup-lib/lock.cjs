"use strict";

/**
 * LOCK DE BACKUP POR BANCO.
 *
 * POR QUE EXISTE: o backup diário (cron) e o botão "Fazer backup agora"
 * podem disparar ao mesmo tempo pro MESMO banco. Dois dumps simultâneos
 * do mesmo container disputam disco/CPU e - pior - dois processos
 * escrevendo no mesmo arquivo final. O lock garante UM dump por
 * projeto+banco por vez; bancos diferentes continuam independentes.
 *
 * COMO FUNCIONA:
 * - criação EXCLUSIVA do arquivo (`wx`): o SO garante que só um processo
 *   cria o arquivo por vez (O_EXCL). Atômico em FS local.
 * - o arquivo guarda o PID de quem pegou o lock + quando.
 * - heartbeat: enquanto o dump roda, o lock é atualizado - se o processo
 *   morre no meio, o PID não existe mais e o próximo job pode assumir.
 * - liberação em `finally`: sucesso ou falha, o lock é solto.
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_STALE_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12h
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

/** Diretório padrão dos locks. */
function defaultLockDir() {
  const home = process.env.HOME || process.env.USERPROFILE;
  const base = home || process.cwd();
  return path.join(base, ".korrelo", "backup-locks");
}

/** Nome de arquivo seguro pro lock (a chave vira nome de arquivo). */
function lockFileName(key) {
  const safe = String(key)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 180);
  return `${safe || "lock"}.lock`;
}

function isProcessAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = o processo existe, mas é de outro usuário.
    return error && error.code === "EPERM";
  }
}

/** Lê o dono do lock (null se não existir/corrompido). */
function readLockOwner(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * O lock está "vivo"? (processo dono ainda existe OU foi atualizado
 * recentemente). Usado também pela retenção pra não apagar backup de
 * job em andamento.
 */
function isLockActive(lockPath, staleTimeoutMs = DEFAULT_STALE_TIMEOUT_MS) {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch {
    return false;
  }
  const owner = readLockOwner(lockPath);
  if (owner && isProcessAlive(owner.pid)) return true;
  if (Date.now() - stat.mtimeMs > staleTimeoutMs) return false;
  // Sem dono válido e recente: trata como órfão (não bloqueia).
  return false;
}

/**
 * Tenta pegar o lock da chave.
 *
 * @param {object} options
 * @param {string} options.key            identificador (ex.: container do banco)
 * @param {string} [options.dir]          diretório dos locks
 * @param {number} [options.staleTimeoutMs]
 * @param {string} [options.jobId]
 * @returns {{acquired: boolean, path: string, reason?: string, release: () => void}}
 */
function acquireLock(options) {
  const {
    key,
    dir = defaultLockDir(),
    staleTimeoutMs = DEFAULT_STALE_TIMEOUT_MS,
    jobId = null,
  } = options || {};

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const lockPath = path.join(dir, lockFileName(key));

  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (!error || error.code !== "EEXIST") {
        return {
          acquired: false,
          path: lockPath,
          reason: `não foi possível criar o lock de backup: ${error && error.message ? error.message : error}`,
          release: () => {},
        };
      }

      // Já existe: lock ativo ou órfão (processo morreu)?
      if (isLockActive(lockPath, staleTimeoutMs)) {
        const owner = readLockOwner(lockPath);
        const ownerPid = owner && owner.pid ? owner.pid : "desconhecido";
        return {
          acquired: false,
          path: lockPath,
          reason: `já existe um backup em andamento para este banco (pid ${ownerPid}).`,
          release: () => {},
        };
      }

      // Órfão: remove e tenta de novo uma única vez.
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        return {
          acquired: false,
          path: lockPath,
          reason: "não foi possível liberar um lock de backup abandonado.",
          release: () => {},
        };
      }
      continue;
    }

    const payload = JSON.stringify({
      pid: process.pid,
      acquiredAt: Date.now(),
      jobId,
      key,
    });
    fs.writeSync(fd, payload);
    fs.closeSync(fd);

    const heartbeat = setInterval(() => {
      try {
        const now = new Date();
        fs.utimesSync(lockPath, now, now);
      } catch {
        // Se sumiu (removido na mão), o próximo acquire() recria.
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();

    let released = false;
    return {
      acquired: true,
      path: lockPath,
      release: () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        const owner = readLockOwner(lockPath);
        // Só remove o lock se ainda for nosso (evita apagar o de outro job).
        if (!owner || owner.pid === process.pid) {
          try {
            fs.rmSync(lockPath, { force: true });
          } catch {
            /* o próximo job detecta o lock órfão */
          }
        }
      },
    };
  }

  return {
    acquired: false,
    path: lockPath,
    reason: "não foi possível pegar o lock de backup.",
    release: () => {},
  };
}

module.exports = {
  acquireLock,
  isLockActive,
  readLockOwner,
  lockFileName,
  defaultLockDir,
  DEFAULT_STALE_TIMEOUT_MS,
};
