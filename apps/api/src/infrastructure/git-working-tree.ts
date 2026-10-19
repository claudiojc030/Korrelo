import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const GIT_TIMEOUT_MS = 15_000;

export interface WorkingTreeState {
  /** true quando não há nada modificado/não rastreado (ignorados não contam). */
  clean: boolean;
  /** Arquivos rastreados com alteração local. */
  modified: string[];
  /** Arquivos não rastreados. */
  untracked: string[];
  branch: string | null;
  commit: string | null;
}

/**
 * Estado do working tree do repositório do Core (READ-ONLY).
 *
 * Usado para IMPEDIR uma atualização do Korrelo quando o operador tem
 * alteração local (o caso real: package-lock.json modificado). Nada é
 * descartado automaticamente - o update é abortado e a decisão é do operador.
 */
export async function inspectWorkingTree(repoDir: string): Promise<WorkingTreeState> {
  const modified: string[] = [];
  const untracked: string[] = [];

  try {
    const { stdout } = await execFile("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: repoDir,
      timeout: GIT_TIMEOUT_MS,
    });
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2);
      const file = line.slice(3).trim();
      if (!file) continue;
      if (code === "??") untracked.push(file);
      else modified.push(file);
    }
  } catch {
    // Sem git (ou erro): tratamos como "não sei" - quem chama decide.
    return { clean: true, modified: [], untracked: [], branch: null, commit: null };
  }

  let branch: string | null = null;
  let commit: string | null = null;
  try {
    const [branchResult, commitResult] = await Promise.all([
      execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir, timeout: GIT_TIMEOUT_MS }),
      execFile("git", ["rev-parse", "HEAD"], { cwd: repoDir, timeout: GIT_TIMEOUT_MS }),
    ]);
    branch = branchResult.stdout.trim();
    commit = commitResult.stdout.trim();
  } catch {
    /* sem git não há branch/commit */
  }

  return { clean: modified.length === 0 && untracked.length === 0, modified, untracked, branch, commit };
}

/**
 * Mensagem de abort (formato padronizado da especificação).
 */
export function formatDirtyWorkingTreeMessage(state: WorkingTreeState): string {
  const lines = ["Working tree contains local changes:"];
  for (const file of state.modified) lines.push(` ${file}`);
  for (const file of state.untracked) lines.push(` ${file}`);
  lines.push("");
  lines.push("Update aborted. Review or stash/restore explicitly.");
  return lines.join("\n");
}
