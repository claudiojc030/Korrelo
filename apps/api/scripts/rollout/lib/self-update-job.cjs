"use strict";

/**
 * JOB DE SELF-UPDATE - lado do runner (JavaScript).
 *
 * O runner DETACHED é o DONO da atualização: ele é quem sabe o progresso
 * real (stages do rollout) e quem sabe quando terminou. A API pode estar
 * reiniciando no meio do update - por isso a persistência NÃO pode depender
 * dela.
 *
 * Incidente real: o rollout terminou com sucesso (os marcadores STEP/DONE
 * estavam no log), mas o JSON do job ficou em status "running" / 0% - porque
 * ninguém escrevia o arquivo durante a execução. A UI ficava presa em 0%.
 *
 * Aqui o runner atualiza o JSON a cada stage, interpreta os marcadores
 * STEP/DONE e finaliza o job no fim (inclusive quando o processo morre sem
 * marcador final).
 *
 * Escrita ATÔMICA (temp + rename): a UI nunca lê um JSON pela metade.
 */

const fs = require("node:fs");
const path = require("node:path");

const STEP_MARKER = "__KORRELO_UPDATE_STEP__";
const DONE_MARKER = "__KORRELO_UPDATE_DONE__";
const META_MARKER = "__KORRELO_UPDATE_META__";

const META_KEYS = ["executorCommit", "previousCommit", "candidateCommit", "previousBranch"];

/** Lê o job (null se ainda não existe/corrompido). */
function readJob(jobFile) {
  try {
    // Tira o BOM: um arquivo gravado com BOM quebraria o JSON.parse e o
    // merge sobrescreveria o job inteiro.
    const raw = fs.readFileSync(jobFile, "utf-8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Escreve o job de forma ATÔMICA: arquivo temporário + rename.
 * Rename é atômico no mesmo filesystem: o leitor vê o arquivo antigo
 * inteiro ou o novo inteiro - nunca um JSON parcial.
 */
function writeJob(jobFile, job) {
  const dir = path.dirname(jobFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(jobFile)}.tmp-${process.pid}`);
  const payload = JSON.stringify(job, null, 2);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, jobFile);
  return job;
}

/** Lê, aplica um patch e grava (atômico). */
function updateJob(jobFile, patch) {
  const current = readJob(jobFile);
  if (current === null) {
    // Job ilegível: NÃO sobrescreve (o merge perderia o id/startedAt).
    return null;
  }
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  return writeJob(jobFile, next);
}

/**
 * Interpreta uma linha de log do rollout.
 *
 * @returns {null|{type:"step"|"done"|"meta", ...}}
 */
function parseMarker(line) {
  const text = String(line ?? "").trim();
  if (text.startsWith(STEP_MARKER)) {
    const [, percent, stage] = text.split("|");
    const progress = Number.parseInt(percent, 10);
    if (!Number.isFinite(progress)) return null;
    return { type: "step", progress: Math.max(0, Math.min(100, progress)), stage: stage ?? null };
  }
  if (text.startsWith(DONE_MARKER)) {
    const [, outcome, message] = text.split("|");
    const success = outcome === "success";
    return {
      type: "done",
      success,
      result: success ? "success" : "failed",
      failureReason: success ? null : sanitizeReason(message),
    };
  }
  if (text.startsWith(META_MARKER)) {
    const [, key, value] = text.split("|");
    if (!META_KEYS.includes(key)) return null;
    return { type: "meta", key, value: value ?? null };
  }
  return null;
}

/** Motivo de falha curto e sem segredo. */
function sanitizeReason(message, env = process.env) {
  let text = String(message ?? "").split("\n")[0].trim().slice(0, 300);
  if (!text) text = "falha não informada";
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value !== "string" || value.length < 8) continue;
    if (!/(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|AUTH)/i.test(key)) continue;
    text = text.split(value).join("***");
  }
  return text;
}

/**
 * Aplica um marcador ao job e devolve o job atualizado (ou null se o
 * marcador não era relevante).
 */
function applyMarker(jobFile, marker, now = new Date()) {
  if (!marker) return null;
  if (marker.type === "step") {
    return updateJob(jobFile, {
      status: "running",
      progress: marker.progress,
      currentStage: marker.stage,
      lastMessage: marker.stage ? `stage: ${marker.stage}` : null,
    });
  }
  if (marker.type === "meta") {
    return updateJob(jobFile, { [marker.key]: marker.value });
  }
  if (marker.type === "done") {
    return updateJob(jobFile, {
      status: marker.success ? "completed" : "failed",
      progress: marker.success ? 100 : undefined,
      currentStage: marker.success ? "complete" : undefined,
      finishedAt: now.toISOString(),
      result: marker.result,
      failureReason: marker.failureReason ?? null,
    });
  }
  return null;
}

/**
 * Finaliza um job que o runner NÃO conseguiu finalizar (processo morreu sem
 * marcador final). Garante que o job não fica "running" eternamente.
 */
function finalizeJob(jobFile, { exitCode, reason }) {
  const current = readJob(jobFile);
  if (!current) return null;
  if (["completed", "failed"].includes(current.status)) return current;
  const now = new Date().toISOString();
  return updateJob(jobFile, {
    status: "failed",
    finishedAt: now,
    result: "incomplete",
    failureReason: sanitizeReason(reason ?? `rollout terminou sem marcador final (exit=${exitCode})`),
  });
}

module.exports = {
  STEP_MARKER,
  DONE_MARKER,
  META_MARKER,
  META_KEYS,
  readJob,
  writeJob,
  updateJob,
  parseMarker,
  applyMarker,
  finalizeJob,
  sanitizeReason,
};
