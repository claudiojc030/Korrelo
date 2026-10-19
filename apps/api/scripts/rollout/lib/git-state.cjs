"use strict";

/**
 * Estado do working tree do Git (read-only).
 *
 * O rollout NÃO pode descartar alteração local nenhuma. Se o tree estiver
 * sujo, o update é abortado e o operador decide (stash/restore/commit).
 *
 * A classificação mostra apenas CAMINHOS (nunca conteúdo de arquivo, nem
 * valores de .env).
 */

const TRACKED_MODIFIED = "trackedModified";
const UNTRACKED = "untracked";
const IGNORED = "ignored";

/**
 * @param {object} options
 * @param {string} options.cwd  raiz do repositório
 * @param {(cmd:string,args:string[],opts?:object)=>Promise<{code:number,stdout:string,stderr:string}>} options.run
 */
async function inspectGitState({ cwd, run }) {
  const branchResult = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  const commitResult = await run("git", ["rev-parse", "HEAD"], { cwd });

  const statusResult = await run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"],
    { cwd },
  );

  const trackedModified = [];
  const untracked = [];
  const ignored = [];

  if (statusResult.code === 0) {
    for (const line of statusResult.stdout.split("\n")) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2);
      const path = line.slice(3).trim();
      if (!path) continue;
      if (code === "??") {
        untracked.push(path);
      } else if (code === "!!") {
        ignored.push(path);
      } else {
        trackedModified.push(path);
      }
    }
  }

  const dirty = trackedModified.length > 0 || untracked.length > 0;

  return {
    branch: branchResult.code === 0 ? branchResult.stdout.trim() : null,
    commit: commitResult.code === 0 ? commitResult.stdout.trim() : null,
    dirty,
    trackedModified,
    untracked,
    ignored,
    /** true quando só há ignorados (não bloqueiam o update). */
    onlyIgnored: !dirty && ignored.length > 0,
  };
}

/**
 * Mensagem de abort (formato pedido na especificação).
 */
function formatDirtyTreeMessage(state) {
  const lines = ["Working tree contains local changes:"];
  for (const path of state.trackedModified) lines.push(` ${path}`);
  for (const path of state.untracked) lines.push(` ${path}`);
  lines.push("");
  lines.push("Update aborted. Review or stash/restore explicitly.");
  return lines.join("\n");
}

module.exports = { inspectGitState, formatDirtyTreeMessage, TRACKED_MODIFIED, UNTRACKED, IGNORED };
