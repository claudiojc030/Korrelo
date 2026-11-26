/**
 * Ativação POR PROJETO do pipeline sequencial (Smart Deploy V2).
 *
 * Default absoluto: DESLIGADO.
 *
 * Regras:
 *  - `KORRELO_SEQUENTIAL_PROJECTS` é uma lista de projectIds separada por
 *    vírgula; somente esses projetos usam o pipeline sequencial;
 *  - `KORRELO_SEQUENTIAL_BUILD=1|true|yes` continua funcionando como opt-in
 *    global para laboratório/rollout amplo;
 *  - `KORRELO_SEQUENTIAL_BUILD=0|false|no|off` é KILL SWITCH: desliga tudo,
 *    mesmo que o projeto esteja na lista;
 *  - ausência de configuração = fluxo antigo.
 */
export function isSequentialBuildEnabledForProject(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const id = (projectId ?? "").trim();
  if (!id) return false;

  const global = (env.KORRELO_SEQUENTIAL_BUILD ?? "").trim().toLowerCase();
  if (global === "0" || global === "false" || global === "no" || global === "off") {
    return false;
  }
  if (global === "1" || global === "true" || global === "yes") return true;

  const allowlist = (env.KORRELO_SEQUENTIAL_PROJECTS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return allowlist.includes(id);
}

/** Texto estável para o painel/prévia (não decide recursos). */
export function describeSequentialBuildMode(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): { enabled: boolean; reason: string } {
  const enabled = isSequentialBuildEnabledForProject(projectId, env);
  if (enabled) {
    return {
      enabled: true,
      reason: "pipeline sequencial habilitado para este projeto",
    };
  }
  const global = (env.KORRELO_SEQUENTIAL_BUILD ?? "").trim().toLowerCase();
  if (global === "0" || global === "false" || global === "no" || global === "off") {
    return { enabled: false, reason: "pipeline sequencial desativado globalmente" };
  }
  return {
    enabled: false,
    reason: "projeto não está na allowlist KORRELO_SEQUENTIAL_PROJECTS",
  };
}
