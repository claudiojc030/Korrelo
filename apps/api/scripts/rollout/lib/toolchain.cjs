"use strict";

/**
 * TOOLCHAIN DE BUILD + DIAGNÓSTICO DE FALHA DE COMANDO.
 *
 * Incidente real (segundo rollout na VPS): com `NODE_ENV=production` no
 * ambiente, o `npm ci` roda com `omit=dev` -> as devDependencies (typescript,
 * que é o que compila o Core) NÃO são instaladas -> `node_modules/.bin/tsc`
 * não existe -> o build de packages/shared-types falha com
 * "tsc: not found" e o rollback falha do mesmo jeito.
 *
 * Solução (local ao rollout, sem mexer no ambiente do servidor):
 * - o install do rollout é `npm ci --include=dev` (a flag vence o `omit=dev`
 *   implícito do NODE_ENV);
 * - depois do install, a toolchain é VALIDADA explicitamente (antes de
 *   qualquer build): se o TypeScript não estiver disponível, o rollout
 *   aborta com mensagem clara em vez de falhar no meio do build;
 * - as falhas de build passam a preservar o exit code e um trecho SANITIZADO
 *   e LIMITADO do stderr/stdout (sem vazar segredo e sem despejar buffer
 *   gigante).
 */

const fs = require("node:fs");
const path = require("node:path");

/** Ferramentas obrigatórias para compilar o Core. */
const REQUIRED_TOOLS = [
  { name: "TypeScript", bin: "tsc", pkg: "typescript" },
];

/** Diretórios de workspace onde o binário pode ter sido instalado. */
const DEFAULT_WORKSPACE_DIRS = [
  path.join("apps", "api"),
  path.join("apps", "web"),
  path.join("packages", "shared-types"),
];

/**
 * Procura o executável da ferramenta em node_modules/.bin.
 *
 * Multiplataforma: no Windows o binário é `tsc.cmd`/`tsc.ps1`; no Unix é
 * `tsc`. Nenhum comando é executado (só a existência do arquivo).
 */
function resolveToolBinary({ repoRoot, bin, workspaceDirs = [] }) {
  const roots = [repoRoot, ...workspaceDirs.map((dir) => path.join(repoRoot, dir))];
  for (const root of roots) {
    const binDir = path.join(root, "node_modules", ".bin");
    for (const name of [bin, `${bin}.cmd`, `${bin}.ps1`, `${bin}.exe`]) {
      const candidate = path.join(binDir, name);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* ignora */
      }
    }
  }
  return null;
}

/** Versão do pacote instalado (null se não instalado). */
function readPackageVersion(pkgDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Verifica se a toolchain de build está disponível depois do install.
 *
 * Rápido, não modifica nada e não executa binário do projeto.
 */
function checkBuildToolchain({
  repoRoot,
  workspaceDirs = DEFAULT_WORKSPACE_DIRS,
  required = REQUIRED_TOOLS,
} = {}) {
  const missing = [];
  const found = [];
  for (const tool of required) {
    const binary = resolveToolBinary({ repoRoot, bin: tool.bin, workspaceDirs });
    const version = readPackageVersion(path.join(repoRoot, "node_modules", tool.pkg));
    if (!binary || !version) {
      missing.push(tool.name);
      continue;
    }
    found.push(`${tool.name} ${version}`);
  }
  return { ok: missing.length === 0, missing, found };
}

/** Remove do texto o valor de variáveis de ambiente sensíveis. */
function sanitizeOutput(text, env = process.env) {
  let out = String(text ?? "");
  if (!env) return out;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length < 8) continue;
    if (!/(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|AUTH)/i.test(key)) continue;
    out = out.split(value).join("***");
  }
  return out;
}

const MAX_OUTPUT_LINES = 8;
const MAX_OUTPUT_CHARS = 2000;

/**
 * Mensagem de falha de comando: exit code + trecho útil (limitado e
 * sanitizado) do stderr/stdout.
 *
 * Exemplo:
 *   build de packages/shared-types falhou (exit=127):
 *   sh: 1: tsc: not found
 */
function formatCommandFailure({ label, stage = null, result, env = process.env }) {
  const code = result && typeof result.code === "number" ? result.code : -1;
  const stderr = String(result?.stderr ?? "").trim();
  const stdout = String(result?.stdout ?? "").trim();
  const raw = stderr || stdout;
  const sanitized = sanitizeOutput(raw, env);
  const lines = sanitized.split("\n").filter((line) => line.trim().length > 0);
  const tail = lines.slice(-MAX_OUTPUT_LINES).join("\n").slice(-MAX_OUTPUT_CHARS);
  const stagePart = stage ? ` [${stage}]` : "";
  const header = `${label} falhou${stagePart} (exit=${code})`;
  return tail ? `${header}:\n${tail}` : header;
}

module.exports = {
  REQUIRED_TOOLS,
  DEFAULT_WORKSPACE_DIRS,
  resolveToolBinary,
  readPackageVersion,
  checkBuildToolchain,
  sanitizeOutput,
  formatCommandFailure,
  MAX_OUTPUT_LINES,
  MAX_OUTPUT_CHARS,
};
