"use strict";

/**
 * SNAPSHOT/RESTAURAÇÃO DE ARTEFATOS DO CORE (sem compilação).
 *
 * Quando o rollout é interrompido DEPOIS do git update, o código no disco
 * pode ser o novo enquanto o Core em execução é o antigo. Um rollback
 * "de verdade" exigiria recompilar - e recompilar sob pressão de recursos
 * ameaça os projetos de produção (Mesatta tem prioridade sobre o painel).
 *
 * Estratégia escolhida:
 * - antes do install/build, copiar (NÃO mover) os artefatos do Core que o
 *   processo em execução lê do disco. Só a API (`apps/api/dist`) entra: é
 *   pequena (poucos MB) e o custo de I/O é irrelevante;
 * - o bundle do web (`.next/standalone`) NÃO é copiado: pode passar de
 *   100 MB e a cópia pressiona o mesmo disco sob pressão (além de
 *   corrida com o servidor Next em execução, que lê esses arquivos por
 *   request);
 * - na recuperação adiada, os artefatos capturados são restaurados por
 *   CÓPIA (sem compilação, sem build, sem restart) e o que não pode ser
 *   garantido (bundle do web) é sinalizado explicitamente como
 *   RECOVERY_REQUIRED - nunca descartado em silêncio.
 *
 * Nada aqui toca em container, volume, rede ou porta de projeto.
 */

const fs = require("node:fs");
const path = require("node:path");

/** Artefatos do Core capturados antes do install/build. */
const ARTIFACTS = [
  { name: "api-dist", rel: path.join("apps", "api", "dist") },
];

/** Tamanho (bytes) de um diretório, com limite de arquivos percorridos. */
function dirSize(dir, maxFiles = 50_000) {
  let total = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length > 0 && files < maxFiles) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        total += fs.statSync(full).size;
      } catch {
        /* arquivo sumiu no meio */
      }
      files += 1;
      if (files >= maxFiles) break;
    }
  }
  return total;
}

/**
 * Captura os artefatos do Core (cópia) ANTES do install/build.
 *
 * Não falha o rollout: se não der para copiar, o rollout segue (sem
 * snapshot) e a recuperação adiada sinaliza o que não pode ser garantido.
 */
function captureArtifacts({ targetRepoRoot, backupDir, stamp, maxBytes = 200 * 1024 * 1024 }) {
  const result = { root: null, captured: [], skipped: [] };
  if (!backupDir) return result;
  const destRoot = path.join(backupDir, stamp);
  result.root = destRoot;

  for (const artifact of ARTIFACTS) {
    const from = path.join(targetRepoRoot, artifact.rel);
    if (!fs.existsSync(from)) {
      result.skipped.push({ name: artifact.name, reason: "não existe" });
      continue;
    }
    const bytes = dirSize(from);
    if (bytes > maxBytes) {
      result.skipped.push({ name: artifact.name, reason: `tamanho ${bytes} bytes acima do limite ${maxBytes}` });
      continue;
    }
    const to = path.join(destRoot, artifact.name);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true });
      result.captured.push({ name: artifact.name, rel: artifact.rel, from, to, bytes });
    } catch (error) {
      result.skipped.push({ name: artifact.name, reason: String(error?.message ?? error) });
    }
  }

  return result;
}

/**
 * Restaura os artefatos capturados (cópia, SEM compilação).
 *
 * Usado na recuperação adiada: devolve ao disco a versão anterior do Core
 * para que um futuro restart não suba com artefatos pela metade.
 */
function restoreArtifacts({ snapshot, targetRepoRoot }) {
  if (!snapshot || !Array.isArray(snapshot.captured) || snapshot.captured.length === 0) {
    return { code: 0, detail: "sem snapshot de artefatos para restaurar" };
  }
  const restored = [];
  const failed = [];
  for (const artifact of snapshot.captured) {
    const to = path.join(targetRepoRoot, artifact.rel);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(artifact.to, to, { recursive: true, force: true });
      restored.push(artifact.name);
    } catch (error) {
      failed.push(`${artifact.name}: ${error?.message ?? error}`);
    }
  }
  return {
    code: failed.length === 0 ? 0 : 1,
    detail:
      `restaurado(s): ${restored.join(", ") || "nada"}` +
      (failed.length > 0 ? ` | falha(s): ${failed.join(", ")}` : ""),
  };
}

module.exports = { ARTIFACTS, dirSize, captureArtifacts, restoreArtifacts };
