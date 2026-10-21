"use strict";

/**
 * MOTOR DE RESTORE SEGURO.
 *
 * Um restore DESTRUTIVO (--drop no Mongo, DROP SCHEMA no Postgres) é a
 * operação mais perigosa do Korrelo. Aqui ela só acontece depois de:
 *
 *   1. validar que o arquivo existe, não é .tmp e não está vazio;
 *   2. validar o manifesto (status + tamanho + sha256) quando existir;
 *   3. criar um BACKUP DE SEGURANÇA do estado atual do banco;
 *   4. só então executar o restore destrutivo.
 *
 * Se o backup de segurança falhar, o restore é ABORTADO - nunca se
 * destrói dado sem ter cópia do que existe hoje.
 *
 * Sem rollback automático (fora do escopo desta wave): se o restore
 * falhar, a mensagem diz exatamente onde está o backup pré-restore.
 */

const fs = require("node:fs");
const path = require("node:path");

const { runProcess } = require("./process-runner.cjs");
const fileLib = require("./backup-file.cjs");
const { dumpDatabase, randomJobId, describeFailure } = require("./dump.cjs");
const { acquireLock, lockKeyForContainer } = require("./lock.cjs");
const { redact } = require("./sanitize.cjs");
const { createProgressWriter, ensureProgressDir } = require("./progress.cjs");

/**
 * Valida o arquivo de backup antes de qualquer operação destrutiva.
 *
 * @param {string} inFile
 * @returns {{ok: boolean, error: string|null, state: string, manifest: object|null, bytes: number}}
 */
function validateBackupFile(inFile) {
  if (!inFile) {
    return { ok: false, error: "arquivo de backup não informado.", state: "invalid", manifest: null, bytes: 0 };
  }

  const baseName = path.basename(inFile);
  if (fileLib.isTempFileName(baseName)) {
    return {
      ok: false,
      error: `o arquivo "${baseName}" ainda está sendo escrito (dump em andamento) - não pode ser restaurado.`,
      state: "invalid",
      manifest: null,
      bytes: 0,
    };
  }

  let stat;
  try {
    stat = fs.statSync(inFile);
  } catch {
    return { ok: false, error: `arquivo de backup não encontrado: ${inFile}`, state: "invalid", manifest: null, bytes: 0 };
  }

  if (!stat.isFile()) {
    return { ok: false, error: `o caminho de backup não é um arquivo: ${inFile}`, state: "invalid", manifest: null, bytes: 0 };
  }
  if (stat.size === 0) {
    return { ok: false, error: "o arquivo de backup está vazio (0 bytes).", state: "invalid", manifest: null, bytes: 0 };
  }

  const { state, manifest } = fileLib.readBackupState(inFile);

  if (state === "incomplete") {
    return {
      ok: false,
      error: "o backup está marcado como incompleto - não pode ser restaurado.",
      state,
      manifest,
      bytes: stat.size,
    };
  }

  if (state === "legacy") {
    // Backup antigo (sem manifesto): não validado, mas o operador pediu
    // explicitamente o restore - segue, com aviso no log.
    return {
      ok: true,
      error: null,
      state,
      manifest: null,
      bytes: stat.size,
    };
  }

  // Estado "complete": confere tamanho e checksum declarados.
  if (typeof manifest.bytes === "number" && manifest.bytes !== stat.size) {
    return {
      ok: false,
      error: `tamanho do arquivo (${stat.size} bytes) não bate com o manifesto (${manifest.bytes} bytes) - backup truncado ou corrompido.`,
      state,
      manifest,
      bytes: stat.size,
    };
  }

  return { ok: true, error: null, state, manifest, bytes: stat.size };
}

/** Confere o sha256 do arquivo contra o manifesto (streaming). */
async function verifyChecksum(inFile, manifest) {
  if (!manifest || typeof manifest.sha256 !== "string" || !manifest.sha256) return { ok: true, error: null };
  const sha256 = await fileLib.sha256File(inFile);
  if (sha256 !== manifest.sha256) {
    return {
      ok: false,
      error: `checksum do backup não confere (esperado ${manifest.sha256.slice(0, 12)}..., obtido ${sha256.slice(0, 12)}...) - arquivo corrompido.`,
    };
  }
  return { ok: true, error: null };
}

/* ------------------------------------------------------------------ *
 * Comandos de restore
 * ------------------------------------------------------------------ */

function buildPostgresRestoreCommands(options) {
  const { containerName, username, password, databaseName } = options;
  const env = { ...process.env };
  if (password) env.PGPASSWORD = password;

  const dropArgs = ["exec"];
  if (password) dropArgs.push("-e", "PGPASSWORD");
  dropArgs.push(containerName, "psql", "-U", username || "postgres", "-d", databaseName || "postgres", "-c", "DROP SCHEMA public CASCADE; CREATE SCHEMA public;");

  const restoreArgs = ["exec", "-i"];
  if (password) restoreArgs.push("-e", "PGPASSWORD");
  restoreArgs.push(containerName, "psql", "-U", username || "postgres", "-d", databaseName || "postgres");

  return [
    { command: "docker", args: dropArgs, env, stdinPath: null },
    { command: "docker", args: restoreArgs, env, stdinPath: "FILE" },
  ];
}

function buildMongoRestoreCommand(options) {
  const { containerName, username, password } = options;
  const args = ["exec", "-i"];
  if (username) args.push("-e", "KORRELO_MONGO_USER");
  if (password) args.push("-e", "KORRELO_MONGO_PASSWORD");
  args.push(
    containerName,
    "sh",
    "-c",
    'exec mongorestore --username "$KORRELO_MONGO_USER" --password "$KORRELO_MONGO_PASSWORD" --authenticationDatabase admin --archive --drop',
  );

  const env = { ...process.env };
  if (username) env.KORRELO_MONGO_USER = username;
  if (password) env.KORRELO_MONGO_PASSWORD = password;

  return { command: "docker", args, env, stdinPath: "FILE" };
}

function buildRedisRestoreCommands(options) {
  const { containerName, inFile } = options;
  return [
    { command: "docker", args: ["cp", inFile, `${containerName}:/data/dump.rdb`], env: { ...process.env }, stdinPath: null },
    { command: "docker", args: ["restart", containerName], env: { ...process.env }, stdinPath: null },
  ];
}

/* ------------------------------------------------------------------ *
 * Restore
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} RestoreResult
 * @property {boolean} ok
 * @property {string|null} error
 * @property {string|null} preRestoreBackupPath  onde está o backup de segurança
 */

/**
 * @param {object} options
 * @param {"postgres"|"mongodb"|"redis"} options.dbType
 * @param {string} options.containerName
 * @param {string} options.inFile
 * @param {string} [options.preRestoreDir]  onde gravar o backup de segurança
 * @param {string} [options.lockDir]         onde fica o lock do banco
 * @param {Function} [options.runProcess]
 * @param {Function} [options.dumpFn]        injetável pra teste
 * @returns {Promise<RestoreResult>}
 */
async function restoreDatabase(options) {
  const {
    dbType,
    containerName,
    username = null,
    password = null,
    databaseName = null,
    inFile,
    preRestoreDir = null,
    lockDir = undefined,
    jobId = randomJobId(),
    projectId = null,
    serviceName = null,
    progressFile = null,
    runProcess = runProcess,
    dumpFn = dumpDatabase,
    onLog = () => {},
    onStep = () => {},
    inactivityTimeoutMs = undefined,
    maxTimeoutMs = undefined,
    stderrLimit = undefined,
    env: extraEnv = null,
  } = options || {};

  const secrets = [password].filter((value) => typeof value === "string" && value.length > 0);
  const log = (message) => onLog(redact(String(message), secrets));
  ensureProgressDir(progressFile);
  const progress = createProgressWriter({ filePath: progressFile, jobId });

  // Heartbeat: um restore grande pode ficar minutos sem produzir log, mas
  // continua vivo - o painel não pode matar o job por isso.
  const heartbeat = setInterval(() => progress.update({}), 10_000);
  heartbeat.unref?.();

  // O restore é DESTRUTIVO: ele segura o lock do banco ALVO do início ao
  // fim (validação -> backup pré-restore -> restore). Sem isso, o cron ou o
  // botão "Fazer backup agora" poderiam entrar no meio e capturar um banco
  // pela metade. O backup pré-restore reaproveita ESTE lock
  // (`lockAlreadyHeld`), então não há auto-deadlock.
  const lock = acquireLock({ key: lockKeyForContainer(containerName), dir: lockDir, jobId });
  if (!lock.acquired) {
    const message = redact(
      lock.reason || "já existe um backup ou restauração em andamento para este banco.",
      secrets,
    );
    progress.close({ phase: "failed", errorMessage: message });
    return { ok: false, error: message, preRestoreBackupPath: null };
  }

  try {
    // 1) Validações do arquivo de backup.
    const validation = validateBackupFile(inFile);
    if (!validation.ok) {
      const message = redact(validation.error, secrets);
      progress.close({ phase: "failed", errorMessage: message });
      return { ok: false, error: message, preRestoreBackupPath: null };
    }
    if (validation.state === "legacy") {
      log("Aviso: backup legado (sem manifesto) - não validado por checksum.");
    }

    // 2) Checksum (só quando existe manifesto).
    const checksum = await verifyChecksum(inFile, validation.manifest);
    if (!checksum.ok) {
      const message = redact(checksum.error, secrets);
      progress.close({ phase: "failed", errorMessage: message });
      return { ok: false, error: message, preRestoreBackupPath: null };
    }

    // 3) Backup de segurança do estado ATUAL do banco.
    onStep(20, "Criando backup de segurança antes de restaurar");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safetyDir = path.join(preRestoreDir || path.join(process.env.BACKUP_DIR || "", "pre-restore"), stamp);
    const safetyFile = path.join(safetyDir, path.basename(inFile));

    progress.update({ phase: "pre-restore" });
    const safety = await dumpFn({
      dbType,
      containerName,
      username,
      password,
      databaseName,
      outFile: safetyFile,
      reason: "pre-restore",
      projectId,
      serviceName,
      jobId: `${jobId}-pre`,
      lockAlreadyHeld: true,
      runProcess,
      onLog: log,
      inactivityTimeoutMs,
      maxTimeoutMs,
      stderrLimit,
    });

    if (!safety.ok) {
      const message = redact(
        `backup de segurança antes do restore falhou - restore abortado (nada foi alterado no banco): ${safety.error}`,
        secrets,
      );
      progress.close({ phase: "failed", errorMessage: message });
      return { ok: false, error: message, preRestoreBackupPath: null };
    }
    log(`Backup de segurança do estado atual salvo em ${safetyFile}.`);

    // 4) Agora sim: o restore destrutivo.
    progress.update({ phase: "restoring" });
    onStep(30, "Restaurando banco de dados");
    let commands;
    if (dbType === "postgres") {
      commands = buildPostgresRestoreCommands({ containerName, username, password, databaseName });
    } else if (dbType === "mongodb") {
      commands = [buildMongoRestoreCommand({ containerName, username, password })];
    } else if (dbType === "redis") {
      commands = buildRedisRestoreCommands({ containerName, inFile });
    } else {
      const message = `tipo de banco não suportado pra restauração: ${dbType}`;
      progress.close({ phase: "failed", errorMessage: message });
      return { ok: false, error: message, preRestoreBackupPath: safetyFile };
    }

    for (const spec of commands) {
      const stdinPath = spec.stdinPath === "FILE" ? inFile : spec.stdinPath;
      const result = await runProcess({
        command: spec.command,
        args: spec.args,
        env: { ...spec.env, ...(extraEnv || {}) },
        stdinPath,
        stderrLimit,
        // H1: o watchdog de INATIVIDADE fica DESLIGADO no restore.
        //
        // O restore é destrutivo e pode ficar minutos (horas) sem produzir
        // NENHUM byte sem estar travado: o `mongorestore --archive` só
        // imprime por coleção (e o progresso por documento só sai em TTY,
        // aqui a saída vai pro arquivo de log) e o `psql` só imprime o
        // "COPY n" no final. Matar o processo no meio deixaria o banco
        // pela metade - bem pior do que esperar. O único limite aqui é o
        // TETO ABSOLUTO (12h por padrão).
        inactivityTimeoutMs: 0,
        maxTimeoutMs,
      });

      if (result.error || result.writeError || result.timedOut || result.code !== 0) {
        const message = redact(
          `falha ao restaurar: ${describeFailure(result, secrets)}. O backup de segurança do estado anterior está em ${safetyFile}.`,
          secrets,
        );
        progress.close({ phase: "failed", errorMessage: message });
        return { ok: false, error: message, preRestoreBackupPath: safetyFile };
      }
    }

    progress.close({ phase: "complete" });
    return { ok: true, error: null, preRestoreBackupPath: safetyFile };
  } finally {
    clearInterval(heartbeat);
    // O lock do banco alvo fica preso durante TODO o restore (inclusive o
    // backup pré-restore) e só é solto aqui - sucesso ou falha.
    lock.release();
  }
}

module.exports = {
  restoreDatabase,
  validateBackupFile,
  verifyChecksum,
  buildPostgresRestoreCommands,
  buildMongoRestoreCommand,
  buildRedisRestoreCommands,
};
