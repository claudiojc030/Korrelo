"use strict";

/**
 * PRIMITIVAS DE ARQUIVO DE BACKUP.
 *
 * Regras que valem pra TODO backup novo:
 *
 *   <dest>.tmp-<jobId>   -> escrito enquanto o dump roda
 *   <dest>               -> só aparece depois de rename atômico
 *   <dest>.manifest.json -> metadados (versão, tamanho, sha256, status)
 *
 * O arquivo final NUNCA aparece antes do dump terminar com sucesso - é o
 * que impede que um dump pela metade seja confundido com backup válido.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const MANIFEST_VERSION = 1;
const MANIFEST_SUFFIX = ".manifest.json";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Sufixo de arquivo temporário: identifica "dump em andamento". */
function isTempFileName(fileName) {
  return /\.tmp-[A-Za-z0-9_-]+/.test(fileName);
}

/** Caminho temporário usado enquanto o dump roda. */
function buildTempPath(finalPath, jobId) {
  const id = String(jobId || "job").replace(/[^A-Za-z0-9_-]+/g, "");
  return `${finalPath}.tmp-${id}`;
}

/** Caminho do manifesto de um backup. */
function buildManifestPath(finalPath) {
  return `${finalPath}${MANIFEST_SUFFIX}`;
}

/** Cria o diretório (com permissão restritiva) se ainda não existir. */
function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: DIR_MODE });
  try {
    fs.chmodSync(dirPath, DIR_MODE);
  } catch {
    /* em Windows a permissão de diretório é best effort */
  }
}

/** Aplica permissão restritiva no arquivo (best effort em Windows). */
function restrictFile(filePath) {
  try {
    fs.chmodSync(filePath, FILE_MODE);
  } catch {
    /* em Windows chmod só mexe no flag de read-only */
  }
}

/**
 * fsync do arquivo + close. Sem isso, o rename pode ser persistido antes
 * do conteúdo - o que deixaria um backup "completo" mas truncado depois
 * de um crash do sistema.
 */
async function fsyncFile(filePath) {
  const handle = await fsp.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** fsync do diretório (pra garantir que o rename é durável). */
async function fsyncDir(dirPath) {
  let handle = null;
  try {
    handle = await fsp.open(dirPath, "r");
    await handle.sync();
  } catch {
    /* nem todo FS suporta fsync de diretório (Windows) */
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/** sha256 do arquivo, em streaming (nunca carrega o arquivo na RAM). */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Tamanho do arquivo em bytes (0 se não existir). */
function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/** Rename atômico (mesmo filesystem) + fsync do diretório. */
async function atomicRename(fromPath, toPath) {
  await fsp.rename(fromPath, toPath);
  await fsyncDir(path.dirname(toPath));
}

/** Remove arquivo/pasta sem estourar erro (cleanup best effort). */
function removeQuietly(targetPath) {
  try {
    fs.rmSync(targetPath, { force: true, recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Grava um JSON de forma atômica (temp + rename), com permissão restritiva.
 */
async function writeJsonAtomic(filePath, data, mode = FILE_MODE) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  try {
    const handle = await fsp.open(tempPath, "w", mode);
    try {
      await handle.writeFile(payload, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    // Se a escrita falhou, o temporário não pode ficar lá fingindo que é
    // um arquivo válido.
    removeQuietly(tempPath);
    throw error;
  }
  try {
    fs.chmodSync(tempPath, mode);
  } catch {
    /* best effort */
  }
  await atomicRename(tempPath, filePath);
}

/** Lê um JSON; devolve null se não existir ou estiver corrompido. */
function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Monta o manifesto de um backup.
 *
 * NÃO guarda segredo nenhum (sem senha, sem URI, sem token) - só o que
 * precisa pra saber se o arquivo está íntegro e de onde veio.
 */
function buildManifest({
  projectId = null,
  dbType,
  serviceName = null,
  containerName = null,
  reason = "manual",
  fileName,
  bytes,
  sha256,
  format,
  createdAt = new Date().toISOString(),
  status = "complete",
}) {
  return {
    version: MANIFEST_VERSION,
    projectId,
    dbType,
    serviceName,
    containerName,
    reason,
    createdAt,
    fileName,
    bytes,
    sha256,
    status,
    format,
  };
}

/** Lê o manifesto ao lado de um backup (null se não existir). */
function readManifest(filePath) {
  return readJson(buildManifestPath(filePath));
}

/** Grava o manifesto ao lado de um backup. */
async function writeManifest(filePath, manifest) {
  const manifestPath = buildManifestPath(filePath);
  await writeJsonAtomic(manifestPath, manifest);
  restrictFile(manifestPath);
  return manifestPath;
}

/**
 * Estado de um backup a partir do manifesto:
 * - "complete": validado (checksum conferido no momento da escrita)
 * - "legacy":   arquivo antigo, sem manifesto (não validado, mas visível)
 * - "incomplete": manifesto diz que não terminou -> não pode ser usado
 */
function readBackupState(filePath) {
  const manifest = readManifest(filePath);
  if (!manifest) {
    return { state: "legacy", manifest: null, validated: false };
  }
  if (manifest.status !== "complete") {
    return { state: "incomplete", manifest, validated: false };
  }
  return { state: "complete", manifest, validated: true };
}

module.exports = {
  MANIFEST_VERSION,
  MANIFEST_SUFFIX,
  FILE_MODE,
  DIR_MODE,
  isTempFileName,
  buildTempPath,
  buildManifestPath,
  ensureDir,
  restrictFile,
  fsyncFile,
  fsyncDir,
  sha256File,
  fileSize,
  atomicRename,
  removeQuietly,
  writeJsonAtomic,
  readJson,
  buildManifest,
  readManifest,
  writeManifest,
  readBackupState,
};
