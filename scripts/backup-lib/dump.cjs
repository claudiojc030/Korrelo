"use strict";

/**
 * MOTOR DE DUMP (banco -> arquivo).
 *
 * É O ÚNICO lugar que sabe fazer dump. Tanto o cron diário
 * (apps/api/scripts/backup.js) quanto o botão "Fazer backup agora"
 * (scripts/export-database.sh) chamam ESTE motor - assim não existem
 * duas implementações com comportamentos diferentes (uma delas com
 * Buffer de 500MB na RAM, outra com streaming).
 *
 * Regras garantidas aqui:
 * - stdout do dump vai direto pro arquivo (RAM constante, backpressure real);
 * - o arquivo final só aparece depois de tudo dar certo (temp + rename);
 * - exit code != 0 / erro de escrita / ENOSPC = FALHA (nada é publicado);
 * - stderr limitado e sanitizado (senha nunca aparece);
 * - sha256 + manifesto (sem segredo) gravados junto do arquivo;
 * - lock por banco (cron e manual não rodam juntos);
 * - preflight de disco ANTES de começar;
 * - permission 600 no arquivo e 700 no diretório.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { runProcess } = require("./process-runner.cjs");
const fileLib = require("./backup-file.cjs");
const { acquireLock } = require("./lock.cjs");
const { checkDiskSpace, referenceBackupBytes, formatBytes } = require("./disk-preflight.cjs");
const { redact } = require("./sanitize.cjs");
const { createProgressWriter, ensureProgressDir } = require("./progress.cjs");

const DUMP_FORMATS = {
  mongodb: "mongodump-archive",
  postgres: "pg_dump-plain",
  redis: "redis-rdb",
  sqlite: "sqlite-backup",
};

/* ------------------------------------------------------------------ *
 * Construção dos comandos (puro: fácil de testar sem Docker)
 * ------------------------------------------------------------------ */

/**
 * Comando do dump do MongoDB.
 *
 * A senha NÃO vai no argv: ela é passada pro container por variável de
 * ambiente (`docker exec -e NOME`, que lê o valor do ambiente do cliente
 * docker) e expandida dentro do container. Assim a senha não aparece em
 * `ps aux` no host nem no argv do processo docker.
 */
function buildMongoDumpCommand(options) {
  const { containerName, username, password } = options;
  const args = ["exec"];
  if (username) args.push("-e", "KORRELO_MONGO_USER");
  if (password) args.push("-e", "KORRELO_MONGO_PASSWORD");
  args.push(
    containerName,
    "sh",
    "-c",
    'exec mongodump --username "$KORRELO_MONGO_USER" --password "$KORRELO_MONGO_PASSWORD" --authenticationDatabase admin --archive',
  );

  const env = { ...process.env };
  if (username) env.KORRELO_MONGO_USER = username;
  if (password) env.KORRELO_MONGO_PASSWORD = password;

  return { command: "docker", args, env };
}

/** Comando do dump do Postgres (dentro do container). */
function buildPostgresDumpCommand(options) {
  const { containerName, username, password, databaseName } = options;
  const args = ["exec"];
  if (password) args.push("-e", "PGPASSWORD");
  args.push(containerName, "pg_dump", "-U", username || "postgres", databaseName || "postgres");

  const env = { ...process.env };
  if (password) env.PGPASSWORD = password;

  return { command: "docker", args, env };
}

/** Comando que salva o RDB do Redis (SENHA via REDISCLI_AUTH, fora do argv). */
function buildRedisSaveCommand(options) {
  const { containerName, password } = options;
  const args = ["exec"];
  if (password) args.push("-e", "REDISCLI_AUTH");
  args.push(containerName, "redis-cli", "SAVE");

  const env = { ...process.env };
  if (password) env.REDISCLI_AUTH = password;

  return { command: "docker", args, env };
}

/** Comando que copia o RDB do container pro arquivo de destino. */
function buildRedisCopyCommand(options) {
  const { containerName, outFile } = options;
  return {
    command: "docker",
    args: ["cp", `${containerName}:/data/dump.rdb`, outFile],
    env: { ...process.env },
  };
}

/** Comando que copia /app/uploads do container pro destino. */
function buildUploadsCopyCommand(options) {
  const { containerName, outDir } = options;
  return {
    command: "docker",
    args: ["cp", `${containerName}:/app/uploads`, outDir],
    env: { ...process.env },
  };
}

/**
 * Quebra uma URL do Postgres em variáveis libpq (PG*) pra não colocar a
 * senha (nem a URI completa) no argv do pg_dump.
 */
function parsePostgresUrl(url) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || undefined,
      port: parsed.port || undefined,
      user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      database: parsed.pathname ? decodeURIComponent(parsed.pathname.replace(/^\//, "")) : undefined,
      sslmode: parsed.searchParams.get("sslmode") || undefined,
    };
  } catch {
    return null;
  }
}

/** Comando do pg_dump do Core (fora do container, direto na máquina). */
function buildCorePostgresDumpCommand(options) {
  const { databaseUrl } = options;
  const parsed = parsePostgresUrl(databaseUrl);
  const env = { ...process.env };
  const args = ["pg_dump"];

  if (parsed) {
    if (parsed.host) env.PGHOST = parsed.host;
    if (parsed.port) env.PGPORT = parsed.port;
    if (parsed.user) env.PGUSER = parsed.user;
    if (parsed.password) env.PGPASSWORD = parsed.password;
    if (parsed.database) env.PGDATABASE = parsed.database;
    if (parsed.sslmode) env.PGSSLMODE = parsed.sslmode;
  } else {
    // Sem parse: o libpq aceita a URI completa em PGDATABASE (segue fora
    // do argv). Nunca usar --dbname=<uri> - isso vazaria a senha no ps.
    env.PGDATABASE = databaseUrl;
  }

  return { command: "pg_dump", args, env };
}

/* ------------------------------------------------------------------ *
 * Motor de dump
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} DumpResult
 * @property {boolean} ok
 * @property {string|null} error      mensagem já sanitizada
 * @property {string|null} outFile
 * @property {number} bytes
 * @property {string|null} sha256
 * @property {object|null} manifest
 * @property {boolean} skipped        nada pra copiar (ex.: uploads vazios)
 */

/**
 * Faz o dump de um banco pro arquivo final (com temp + rename + manifesto).
 *
 * @param {object} options
 * @param {"postgres"|"mongodb"|"redis"} options.dbType
 * @param {string} options.containerName
 * @param {string} [options.username]
 * @param {string} [options.password]
 * @param {string} [options.databaseName]
 * @param {string} options.outFile     caminho FINAL do backup
 * @param {string} [options.reason]    "cron" | "manual" | "pre-restore" | ...
 * @param {string} [options.projectId]
 * @param {string} [options.serviceName]
 * @param {string} [options.jobId]
 * @param {string} [options.progressFile]
 * @param {string} [options.lockDir]
 * @param {string} [options.backupRoot]
 * @param {boolean} [options.writeManifest]
 * @param {Function} [options.runProcess] injetável pra teste
 * @param {(message: string) => void} [options.onLog]
 * @returns {Promise<DumpResult>}
 */
async function dumpDatabase(options) {
  const {
    dbType,
    containerName,
    username = null,
    password = null,
    databaseName = null,
    outFile,
    reason = "manual",
    projectId = null,
    serviceName = null,
    jobId = randomJobId(),
    progressFile = null,
    lockDir = undefined,
    backupRoot = null,
    writeManifest = true,
    runProcess = runProcess,
    onLog = () => {},
    inactivityTimeoutMs = undefined,
    maxTimeoutMs = undefined,
    stderrLimit = undefined,
    env: extraEnv = null,
  } = options || {};

  const secrets = [password].filter((value) => typeof value === "string" && value.length > 0);
  const log = (message) => onLog(redact(String(message), secrets));

  if (!outFile) {
    return { ok: false, error: "destino do backup não informado.", outFile: null, bytes: 0, sha256: null, manifest: null, skipped: false };
  }
  if (!containerName) {
    return { ok: false, error: "container do banco não informado.", outFile: null, bytes: 0, sha256: null, manifest: null, skipped: false };
  }

  const outDir = path.dirname(outFile);
  fileLib.ensureDir(outDir);
  ensureProgressDir(progressFile);

  // Lock por banco: o mesmo container não gera dois dumps ao mesmo tempo
  // (cron x botão "Fazer backup agora").
  const lock = acquireLock({ key: `db-${containerName}`, dir: lockDir, jobId });
  if (!lock.acquired) {
    return {
      ok: false,
      error: lock.reason || "já existe um backup em andamento para este banco.",
      outFile: null,
      bytes: 0,
      sha256: null,
      manifest: null,
      skipped: false,
    };
  }

  const tempPath = fileLib.buildTempPath(outFile, jobId);
  const manifestPath = fileLib.buildManifestPath(outFile);
  const progress = createProgressWriter({ filePath: progressFile, jobId });

  // Heartbeat: mesmo sem bytes novos, o job é marcado como vivo. É o que
  // impede o falso "30 minutos sem mexer no log = dump morto".
  const heartbeat = setInterval(() => progress.update({}), 10_000);
  heartbeat.unref?.();

  try {
    // Preflight de disco: falha ANTES do dump se não couber.
    const referenceBytes = referenceBackupBytes(backupRoot, path.basename(outFile));
    const space = checkDiskSpace({ dir: outDir, referenceBytes });
    log(space.message);
    if (!space.ok) {
      progress.close({ phase: "failed", errorMessage: space.message });
      return { ok: false, error: space.message, outFile: null, bytes: 0, sha256: null, manifest: null, skipped: false };
    }

    fileLib.removeQuietly(tempPath);
    removeStaleManifestTemps(manifestPath);

    progress.update({ phase: "dumping" });

    let commandSpec;
    if (dbType === "mongodb") {
      commandSpec = buildMongoDumpCommand({ containerName, username, password });
    } else if (dbType === "postgres") {
      commandSpec = buildPostgresDumpCommand({ containerName, username, password, databaseName });
    } else if (dbType === "redis") {
      // Redis é em duas etapas: SAVE (dentro do container) + cp do RDB.
      const saveSpec = buildRedisSaveCommand({ containerName, password });
      const saveResult = await runProcess({
        command: saveSpec.command,
        args: saveSpec.args,
        env: { ...saveSpec.env, ...(extraEnv || {}) },
        stderrLimit,
        inactivityTimeoutMs,
        maxTimeoutMs,
      });
      if (saveResult.error || saveResult.code !== 0) {
        const message = `falha ao salvar o RDB do Redis: ${describeFailure(saveResult, secrets)}`;
        progress.close({ phase: "failed", errorMessage: message });
        return { ok: false, error: message, outFile: null, bytes: 0, sha256: null, manifest: null, skipped: false };
      }

      commandSpec = buildRedisCopyCommand({ containerName, outFile: tempPath });
      const copyResult = await runProcess({
        command: commandSpec.command,
        args: commandSpec.args,
        env: { ...commandSpec.env, ...(extraEnv || {}) },
        stderrLimit,
        inactivityTimeoutMs,
        maxTimeoutMs,
      });
      const copyFailure = describeFailure(copyResult, secrets);
      if (copyResult.error || copyResult.code !== 0) {
        const message = `falha ao copiar o RDB do Redis: ${copyFailure}`;
        fileLib.removeQuietly(tempPath);
        progress.close({ phase: "failed", errorMessage: message });
        return { ok: false, error: message, outFile: null, bytes: 0, sha256: null, manifest: null, skipped: false };
      }
      if (fileLib.fileSize(tempPath) === 0) {
        const message = "falha ao copiar o RDB do Redis: arquivo ficou vazio.";
        fileLib.removeQuietly(tempPath);
        progress.close({ phase: "failed", errorMessage: message });
        return { ok: false, error: message, outFile: null, bytes: 0, sha256: null, manifest: null, skipped: false };
      }
    } else {
      return {
        ok: false,
        error: `tipo de banco não suportado pra dump: ${dbType}`,
        outFile: null,
        bytes: 0,
        sha256: null,
        manifest: null,
        skipped: false,
      };
    }

    if (dbType !== "redis") {
      const result = await runProcess({
        command: commandSpec.command,
        args: commandSpec.args,
        env: { ...commandSpec.env, ...(extraEnv || {}) },
        stdoutPath: tempPath,
        stdoutMode: fileLib.FILE_MODE,
        stderrLimit,
        inactivityTimeoutMs,
        maxTimeoutMs,
        onProgress: (bytes) => progress.update({ phase: "dumping", bytesWritten: bytes }),
      });

      const failure = describeFailure(result, secrets);
      if (result.error || result.writeError || result.timedOut || result.code !== 0) {
        fileLib.removeQuietly(tempPath);
        const message = `falha ao gerar o dump: ${failure}`;
        progress.close({ phase: "failed", errorMessage: message, bytesWritten: result.bytesWritten });
        return { ok: false, error: message, outFile: null, bytes: 0, sha256: null, manifest: null, skipped: false };
      }

      const bytes = fileLib.fileSize(tempPath);
      if (bytes === 0) {
        fileLib.removeQuietly(tempPath);
        const message = "falha ao gerar o dump: o comando terminou sem escrever nenhum byte.";
        progress.close({ phase: "failed", errorMessage: message });
        return { ok: false, error: message, outFile: null, bytes: 0, sha256: null, manifest: null, skipped: false };
      }
    }

    // Durabilidade: fsync antes de publicar.
    await fileLib.fsyncFile(tempPath);
    const bytes = fileLib.fileSize(tempPath);
    const sha256 = await fileLib.sha256File(tempPath);

    const manifest = fileLib.buildManifest({
      projectId,
      dbType,
      serviceName,
      containerName,
      reason,
      fileName: path.basename(outFile),
      bytes,
      sha256,
      format: DUMP_FORMATS[dbType] || "unknown",
    });

    // Publicação em duas etapas (data + manifesto), na ordem que NUNCA
    // deixa manifesto casando com outro arquivo:
    //
    //   1. manifesto é escrito num arquivo temporário (ainda invisível);
    //   2. o manifesto ANTIGO é removido (o arquivo antigo, se existir,
    //      continua utilizável, só deixa de estar "validado");
    //   3. o dump é publicado por rename atômico;
    //   4. o manifesto novo é publicado por rename atômico.
    //
    // Se o processo morrer entre 3 e 4, o arquivo novo fica sem manifesto
    // - ou seja, aparece como "não validado" (legado), nunca com um
    // checksum que não bate com o conteúdo.
    const manifestTempPath = fileLib.buildTempPath(manifestPath, jobId);
    if (writeManifest) {
      await fileLib.writeJsonAtomic(manifestTempPath, manifest);
      fileLib.removeQuietly(manifestPath);
    }

    await fileLib.atomicRename(tempPath, outFile);
    fileLib.restrictFile(outFile);

    if (writeManifest) {
      await fileLib.atomicRename(manifestTempPath, manifestPath);
      fileLib.restrictFile(manifestPath);
    }

    progress.close({ phase: "complete", bytesWritten: bytes });

    return {
      ok: true,
      error: null,
      outFile,
      bytes,
      sha256,
      manifest,
      manifestPath: writeManifest ? manifestPath : null,
      skipped: false,
    };
  } catch (error) {
    fileLib.removeQuietly(tempPath);
    const message = redact(`falha inesperada no dump: ${error && error.message ? error.message : error}`, secrets);
    progress.close({ phase: "failed", errorMessage: message });
    return { ok: false, error: message, outFile: null, bytes: 0, sha256: null, manifest: null, skipped: false };
  } finally {
    clearInterval(heartbeat);
    lock.release();
  }
}

/* ------------------------------------------------------------------ *
 * Uploads (docker cp) - sem depender de maxBuffer
 * ------------------------------------------------------------------ */

/**
 * Copia /app/uploads do container do projeto pro destino.
 *
 * Erros NÃO são engolidos: ENOSPC, permissão e falha do docker cp entram
 * em `failures`. A única exceção é "/app/uploads não existe" (projeto
 * que nunca recebeu arquivo) - nesse caso é um skip, não uma falha.
 *
 * @param {object} options
 * @param {string} options.containerName
 * @param {string} options.outDir       caminho FINAL do diretório de uploads
 * @param {string} [options.jobId]
 * @param {Function} [options.runProcess]
 * @returns {Promise<DumpResult>}
 */
async function dumpUploads(options) {
  const {
    containerName,
    outDir,
    jobId = randomJobId(),
    runProcess = runProcess,
    onLog = () => {},
    stderrLimit = undefined,
    inactivityTimeoutMs = undefined,
    maxTimeoutMs = undefined,
  } = options || {};

  const parentDir = path.dirname(outDir);
  fileLib.ensureDir(parentDir);

  const tempDir = fileLib.buildTempPath(outDir, jobId);
  const trashDir = `${outDir}.old-${jobId}`;

  fileLib.removeQuietly(tempDir);

  const spec = buildUploadsCopyCommand({ containerName, outDir: tempDir });
  const result = await runProcess({
    command: spec.command,
    args: spec.args,
    env: spec.env,
    stderrLimit,
    inactivityTimeoutMs,
    maxTimeoutMs,
  });

  const stderr = String(result.stderr || "");
  const missing =
    /could not find|no such file or directory|not found/i.test(stderr) &&
    result.code !== 0;

  if (result.error || result.code !== 0) {
    fileLib.removeQuietly(tempDir);
    if (missing) {
      onLog("uploads: container sem /app/uploads - nada a copiar.");
      return { ok: true, error: null, outFile: outDir, bytes: 0, sha256: null, manifest: null, skipped: true };
    }
    const message = `falha ao copiar os uploads: ${describeFailure(result, [])}`;
    return { ok: false, error: message, outFile: null, bytes: 0, sha256: null, manifest: null, skipped: false };
  }

  // Publicação atômica: o diretório antigo sai de cena, o novo entra.
  const hadPrevious = fs.existsSync(outDir);
  if (hadPrevious) {
    fileLib.removeQuietly(trashDir);
    try {
      await fsp.rename(outDir, trashDir);
    } catch {
      fileLib.removeQuietly(outDir);
    }
  }
  try {
    await fsp.rename(tempDir, outDir);
  } catch (error) {
    // Falhou a publicação: tenta voltar o backup anterior.
    if (hadPrevious && !fs.existsSync(outDir)) {
      try {
        await fsp.rename(trashDir, outDir);
      } catch {
        /* nada a fazer */
      }
    }
    fileLib.removeQuietly(tempDir);
    const message = `falha ao publicar os uploads copiados: ${error && error.message ? error.message : error}`;
    return { ok: false, error: message, outFile: null, bytes: 0, sha256: null, manifest: null, skipped: false };
  }
  fileLib.removeQuietly(trashDir);

  return { ok: true, error: null, outFile: outDir, bytes: 0, sha256: null, manifest: null, skipped: false };
}

/* ------------------------------------------------------------------ *
 * Core (SQLite / Postgres do próprio Korrelo)
 * ------------------------------------------------------------------ */

/**
 * Backup do banco do Core.
 *
 * - SQLite: usa o `.backup` do próprio sqlite3 (cópia consistente mesmo
 *   com escrita concorrente) e valida com PRAGMA integrity_check. Sem o
 *   binário sqlite3 na máquina, cai pro copyFile (como antes).
 * - Postgres: pg_dump em streaming, com as credenciais no ambiente
 *   (nada de senha no argv).
 *
 * @param {object} options
 * @param {string} options.databaseUrl
 * @param {string} options.outFile
 * @param {string} [options.sqliteFile]  caminho do arquivo SQLite (se file:)
 * @returns {Promise<DumpResult>}
 */
async function dumpCoreDatabase(options) {
  const {
    databaseUrl,
    outFile,
    sqliteFile = null,
    jobId = randomJobId(),
    reason = "cron",
    runProcess = runProcess,
    onLog = () => {},
    writeManifest = true,
    inactivityTimeoutMs = undefined,
    maxTimeoutMs = undefined,
    stderrLimit = undefined,
  } = options || {};

  const outDir = path.dirname(outFile);
  fileLib.ensureDir(outDir);

  const tempPath = fileLib.buildTempPath(outFile, jobId);
  const manifestPath = fileLib.buildManifestPath(outFile);
  const secrets = [];

  fileLib.removeQuietly(tempPath);

  try {
    if (databaseUrl.startsWith("file:")) {
      if (!sqliteFile) {
        return { ok: false, error: "arquivo SQLite do Core não resolvido.", outFile: null, bytes: 0, sha256: null, manifest: null, skipped: false };
      }

      const backupSpec = {
        command: "sqlite3",
        args: [sqliteFile, `.backup '${tempPath}'`],
        env: { ...process.env },
      };
      const backupResult = await runProcess({
        command: backupSpec.command,
        args: backupSpec.args,
        env: backupSpec.env,
        stderrLimit,
        inactivityTimeoutMs,
        maxTimeoutMs,
      });

      if (backupResult.error || backupResult.code !== 0) {
        // Sem o binário sqlite3: cópia direta (fallback de sempre).
        try {
          await fsp.copyFile(sqliteFile, tempPath);
          onLog("Core (SQLite): sqlite3 indisponível, foi feita cópia direta do arquivo.");
        } catch (error) {
          fileLib.removeQuietly(tempPath);
          const message = `falha no backup do Core (SQLite): ${error && error.message ? error.message : error}`;
          return { ok: false, error: message, outFile: null, bytes: 0, sha256: null, manifest: null, skipped: false };
        }
      } else {
        // Integridade: o backup do Core precisa passar no integrity_check.
        const checkResult = await runProcess({
          command: "sqlite3",
          args: [tempPath, "PRAGMA integrity_check;"],
          env: { ...process.env },
          stderrLimit,
          inactivityTimeoutMs,
          maxTimeoutMs,
        });
        const checkOutput = String(checkResult.stdout || "").trim().toLowerCase();
        if (checkResult.code === 0 && checkOutput && checkOutput !== "ok") {
          fileLib.removeQuietly(tempPath);
          const message = `backup do Core (SQLite) reprovou no integrity_check: ${checkOutput}`;
          return { ok: false, error: message, outFile: null, bytes: 0, sha256: null, manifest: null, skipped: false };
        }
      }
    } else if (databaseUrl.startsWith("postgres")) {
      const spec = buildCorePostgresDumpCommand({ databaseUrl });
      secrets.push(databaseUrl);
      const result = await runProcess({
        command: spec.command,
        args: spec.args,
        env: spec.env,
        stdoutPath: tempPath,
        stdoutMode: fileLib.FILE_MODE,
        stderrLimit,
        inactivityTimeoutMs,
        maxTimeoutMs,
      });
      const failure = describeFailure(result, secrets);
      if (result.error || result.writeError || result.timedOut || result.code !== 0) {
        fileLib.removeQuietly(tempPath);
        const message = `falha no backup do Core (Postgres): ${failure}`;
        return { ok: false, error: message, outFile: null, bytes: 0, sha256: null, manifest: null, skipped: false };
      }
    } else {
      return {
        ok: false,
        error: `DATABASE_URL não reconhecido pra backup: ${databaseUrl}`,
        outFile: null,
        bytes: 0,
        sha256: null,
        manifest: null,
        skipped: false,
      };
    }

    const bytes = fileLib.fileSize(tempPath);
    if (bytes === 0) {
      fileLib.removeQuietly(tempPath);
      const message = "falha no backup do Core: o arquivo ficou vazio.";
      return { ok: false, error: message, outFile: null, bytes: 0, sha256: null, manifest: null, skipped: false };
    }

    await fileLib.fsyncFile(tempPath);
    const sha256 = await fileLib.sha256File(tempPath);
    const manifest = fileLib.buildManifest({
      projectId: null,
      dbType: databaseUrl.startsWith("file:") ? "sqlite" : "postgres",
      serviceName: "core",
      containerName: null,
      reason,
      fileName: path.basename(outFile),
      bytes,
      sha256,
      format: databaseUrl.startsWith("file:") ? DUMP_FORMATS.sqlite : DUMP_FORMATS.postgres,
    });

    if (writeManifest) {
      await fileLib.writeManifest(outFile, manifest);
    }
    await fileLib.atomicRename(tempPath, outFile);
    fileLib.restrictFile(outFile);

    return {
      ok: true,
      error: null,
      outFile,
      bytes,
      sha256,
      manifest,
      manifestPath: writeManifest ? manifestPath : null,
      skipped: false,
    };
  } catch (error) {
    fileLib.removeQuietly(tempPath);
    const message = redact(`falha inesperada no backup do Core: ${error && error.message ? error.message : error}`, secrets);
    return { ok: false, error: message, outFile: null, bytes: 0, sha256: null, manifest: null, skipped: false };
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function randomJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Remove manifestos temporários deixados por um job que morreu no meio
 * (o `.tmp-<pid>-<ts>` do manifesto). Só remove os que têm mais de 1h -
 * um manifesto temporário de um dump RODANDO não pode ser apagado.
 */
function removeStaleManifestTemps(manifestPath) {
  const maxAgeMs = 60 * 60 * 1000;
  try {
    const dir = path.dirname(manifestPath);
    const prefix = `${path.basename(manifestPath)}.tmp-`;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const candidate = path.join(dir, name);
      try {
        const stat = fs.statSync(candidate);
        if (Date.now() - stat.mtimeMs < maxAgeMs) continue;
      } catch {
        continue;
      }
      fileLib.removeQuietly(candidate);
    }
  } catch {
    /* best effort */
  }
}

/** Descreve a falha de um processo de forma útil (e sem senha). */
function describeFailure(result, secrets = []) {
  if (!result) return "resultado desconhecido.";
  if (result.writeError) {
    const code = result.writeError.code ? ` (${result.writeError.code})` : "";
    return `falha ao escrever no arquivo de destino${code}: ${result.writeError.message}`;
  }
  if (result.error) {
    return `falha ao executar o comando: ${result.error.message || result.error}`;
  }
  if (result.inactivityTimedOut) {
    return "o dump parou de escrever dados (timeout por inatividade).";
  }
  if (result.maxTimedOut) {
    return "o dump excedeu o tempo máximo permitido.";
  }
  if (result.timedOut) {
    return "o dump foi interrompido por timeout.";
  }
  if (result.code !== 0) {
    const stderr = String(result.stderr || "").trim();
    const tail = stderr ? `: ${stderr.slice(-800)}` : "";
    return `o comando terminou com código ${result.code}${tail}`;
  }
  return "erro desconhecido.";
}

module.exports = {
  dumpDatabase,
  dumpCoreDatabase,
  dumpUploads,
  buildMongoDumpCommand,
  buildPostgresDumpCommand,
  buildRedisSaveCommand,
  buildRedisCopyCommand,
  buildUploadsCopyCommand,
  buildCorePostgresDumpCommand,
  parsePostgresUrl,
  describeFailure,
  randomJobId,
  DUMP_FORMATS,
  formatBytes,
};
