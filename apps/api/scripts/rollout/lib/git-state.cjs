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

/**
 * Restaura o estado do Git do checkout ALVO: a BRANCH original e o
 * COMMIT anterior.
 *
 * Bug real corrigido aqui: o rollback antigo fazia só
 * `git checkout <previousCommit>`, o que deixa o checkout em DETACHED HEAD
 * (e a branch local continuava apontando para o commit novo). Depois disso
 * o operador precisava de `git checkout main` + `git reset --hard` na mão.
 *
 * Regras (todas obrigatórias):
 * - a branch e o commit têm que ter sido capturados ANTES do update;
 * - o alvo tem que ser exatamente o repositório esperado (validado);
 * - se o working tree tiver alteração tracked INESPERADA, NADA é resetado:
 *   a restauração é interrompida (dados do operador não se perdem);
 * - o RESET é local (`reset --hard` move só a branch local): o remoto nunca
 *   é tocado.
 *
 * Devolve também a lista de caminhos alterados (nunca conteúdo).
 */
async function restoreTargetGitState({
  targetRepoRoot,
  previousBranch,
  previousCommit,
  allowedPaths = [],
  run,
  timeoutMs = 60_000,
}) {
  const steps = [];

  if (!previousBranch || previousBranch === "HEAD") {
    return {
      ok: false,
      reason: "branch anterior desconhecida (o alvo precisa estar em uma branch antes do update)",
      steps,
    };
  }
  if (!previousCommit) {
    return { ok: false, reason: "commit anterior desconhecido", steps };
  }

  // 1) O alvo tem que ser um repositório Git válido.
  const inside = await run("git", ["-C", targetRepoRoot, "rev-parse", "--is-inside-work-tree"], {
    timeoutMs,
  });
  steps.push({ step: "validate-repo", code: inside.code });
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return { ok: false, reason: `checkout alvo não é um repositório Git válido: ${targetRepoRoot}`, steps };
  }

  // 2) Working tree: alteração tracked inesperada IMPEDE a restauração.
  const status = await run(
    "git",
    ["-C", targetRepoRoot, "status", "--porcelain=v1", "--untracked-files=no"],
    { timeoutMs },
  );
  steps.push({ step: "check-worktree", code: status.code });
  if (status.code === 0) {
    const tracked = status.stdout
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("??"))
      // Formato porcelain: "XY <caminho>" - o caminho começa na posição 3.
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    const unexpected = tracked.filter((file) => !allowedPaths.includes(file));
    if (unexpected.length > 0) {
      return {
        ok: false,
        dirty: true,
        paths: unexpected,
        reason:
          "working tree contém alterações inesperadas; restauração automática da branch foi interrompida para não perder dados. " +
          `Arquivos: ${unexpected.join(", ")}`,
        steps,
      };
    }
  }

  // 3) Volta para a branch original.
  const checkout = await run("git", ["-C", targetRepoRoot, "checkout", previousBranch], {
    cwd: targetRepoRoot,
    timeoutMs,
  });
  steps.push({ step: "checkout-branch", code: checkout.code });
  if (checkout.code !== 0) {
    return {
      ok: false,
      reason: `git checkout ${previousBranch} falhou: ${checkout.stderr.trim() || checkout.stdout.trim()}`,
      steps,
    };
  }

  // 4) Move SÓ a branch local de volta ao commit anterior (o remoto intacto).
  const reset = await run("git", ["-C", targetRepoRoot, "reset", "--hard", previousCommit], {
    cwd: targetRepoRoot,
    timeoutMs,
  });
  steps.push({ step: "reset-branch", code: reset.code });
  if (reset.code !== 0) {
    return {
      ok: false,
      reason: `git reset --hard ${previousCommit} falhou: ${reset.stderr.trim() || reset.stdout.trim()}`,
      steps,
    };
  }

  // 5) Confirma branch + HEAD (nunca aceitar detached HEAD).
  const branch = await run("git", ["-C", targetRepoRoot, "branch", "--show-current"], { timeoutMs });
  const head = await run("git", ["-C", targetRepoRoot, "rev-parse", "HEAD"], { timeoutMs });
  const currentBranch = branch.code === 0 ? branch.stdout.trim() : "";
  const currentCommit = head.code === 0 ? head.stdout.trim() : "";
  steps.push({ step: "verify", code: branch.code === 0 && head.code === 0 ? 0 : 1 });

  if (!currentBranch) {
    return {
      ok: false,
      reason: "restauração terminou em detached HEAD: a branch original não pôde ser recuperada",
      branch: currentBranch,
      commit: currentCommit,
      steps,
    };
  }
  if (currentBranch !== previousBranch) {
    return {
      ok: false,
      reason: `branch restaurada incorreta: ${currentBranch} (esperado ${previousBranch})`,
      branch: currentBranch,
      commit: currentCommit,
      steps,
    };
  }
  if (currentCommit !== previousCommit) {
    return {
      ok: false,
      reason: `commit restaurado incorreto: ${currentCommit} (esperado ${previousCommit})`,
      branch: currentBranch,
      commit: currentCommit,
      steps,
    };
  }

  return { ok: true, branch: currentBranch, commit: currentCommit, steps };
}

/**
 * Verifica (read-only) se o checkout alvo está na branch e no commit
 * esperados. Branch vazia = detached HEAD = INVÁLIDO.
 */
async function verifyTargetGitState({ targetRepoRoot, expectedBranch, expectedCommit, run, timeoutMs = 30_000 }) {
  const branch = await run("git", ["-C", targetRepoRoot, "branch", "--show-current"], { timeoutMs });
  const head = await run("git", ["-C", targetRepoRoot, "rev-parse", "HEAD"], { timeoutMs });
  const currentBranch = branch.code === 0 ? branch.stdout.trim() : "";
  const currentCommit = head.code === 0 ? head.stdout.trim() : "";
  const problems = [];
  if (!currentBranch) problems.push("checkout em detached HEAD (sem branch)");
  if (expectedBranch && currentBranch !== expectedBranch) {
    problems.push(`branch ${currentBranch || "(vazia)"} != ${expectedBranch}`);
  }
  if (expectedCommit && currentCommit !== expectedCommit) {
    problems.push(`commit ${currentCommit || "(vazio)"} != ${expectedCommit}`);
  }
  return {
    ok: problems.length === 0,
    branch: currentBranch,
    commit: currentCommit,
    problems,
  };
}

module.exports = {
  inspectGitState,
  formatDirtyTreeMessage,
  restoreTargetGitState,
  verifyTargetGitState,
  TRACKED_MODIFIED,
  UNTRACKED,
  IGNORED,
};
