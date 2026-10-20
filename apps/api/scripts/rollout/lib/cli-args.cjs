"use strict";

/**
 * Parsing EXPLÍCITO dos argumentos do CLI de rollout.
 *
 * Regra inegociável: argumento desconhecido ABORTA. Nunca é ignorado.
 *
 * O caso real que motivou isso: `--repo-root /home/korrelo/korrelo` foi
 * ignorado silenciosamente (o CLI antigo não conhecia a flag) e o rollout
 * rodou contra o próprio worktree temporário do executor, em vez do
 * checkout de produção.
 *
 * Argumentos aceitos:
 *   --plan              só imprime o plano teórico
 *   --apply             executa o rollout de verdade
 *   --repo-root <path>  checkout ALVO (o que será atualizado). Padrão: o
 *                       próprio repositório do executor.
 *   --repo-root=<path>  forma equivalente
 */

const ALLOWED_FLAGS = ["--plan", "--apply", "--repo-root"];

const USAGE = "uso: rollout.cjs [--plan | --apply] [--repo-root <path>]";

/**
 * @param {string[]} argv argumentos (sem node/script)
 * @returns {{mode: "plan"|"dry-run"|"apply", repoRoot: string|null}}
 */
function parseArgs(argv = []) {
  const parsed = {
    mode: "dry-run",
    repoRoot: null,
  };
  let sawPlan = false;
  let sawApply = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = String(argv[index]);

    if (arg === "--plan") {
      sawPlan = true;
      continue;
    }

    if (arg === "--apply") {
      sawApply = true;
      continue;
    }

    if (arg === "--repo-root") {
      const value = argv[index + 1];
      if (value === undefined || value === null || String(value).trim() === "") {
        throw new Error("--repo-root requer um caminho");
      }
      if (String(value).startsWith("--")) {
        throw new Error("--repo-root requer um caminho");
      }
      parsed.repoRoot = String(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--repo-root=")) {
      const value = arg.slice("--repo-root=".length).trim();
      if (!value) {
        throw new Error("--repo-root requer um caminho");
      }
      parsed.repoRoot = value;
      continue;
    }

    throw new Error(
      `argumento inválido: ${arg}. Argumentos aceitos: ${ALLOWED_FLAGS.join(", ")}. ${USAGE}`,
    );
  }

  if (sawPlan && sawApply) {
    throw new Error(`--plan e --apply não podem ser usados juntos. ${USAGE}`);
  }

  if (sawApply) parsed.mode = "apply";
  if (sawPlan) parsed.mode = "plan";

  return parsed;
}

module.exports = { parseArgs, ALLOWED_FLAGS, USAGE };
