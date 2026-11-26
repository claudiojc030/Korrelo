/**
 * ISOLAMENTO OPCIONAL DE PROJETO (laboratório).
 *
 * Default: DESLIGADO. Nenhum projeto existente muda.
 *
 * Ativação por allowlist de projectIds:
 *   KORRELO_ISOLATED_PROJECTS="id-lab-1,id-lab-2"
 *
 * Quando ativo, o compose do projeto:
 *  - NÃO anexa app/app_staging à rede compartilhada `korrelo-shared`;
 *  - usa somente a rede `default` do próprio projeto;
 *  - mantém portas apenas em 127.0.0.1;
 *  - aplica limites explícitos de CPU e PIDs (memória já é mem_limit).
 *
 * Isso não cria banco nem volume novo e não altera projetos fora da lista.
 */

export interface ProjectRuntimeIsolation {
  enabled: boolean;
  cpus: number | null;
  pidsLimit: number | null;
  reason: string;
}

const DEFAULT_CPU_LIMIT = 0.25;
const DEFAULT_PIDS_LIMIT = 64;
const MAX_CPU_LIMIT = 4;
const MAX_PIDS_LIMIT = 4_096;

function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function numberFromEnv(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseFloat(raw ?? "");
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
}

export function resolveProjectRuntimeIsolation(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): ProjectRuntimeIsolation {
  const id = (projectId ?? "").trim();
  const allowlist = parseAllowlist(env.KORRELO_ISOLATED_PROJECTS);
  if (!id || !allowlist.includes(id)) {
    return {
      enabled: false,
      cpus: null,
      pidsLimit: null,
      reason: "projeto não está na allowlist KORRELO_ISOLATED_PROJECTS",
    };
  }

  return {
    enabled: true,
    cpus: numberFromEnv(env.KORRELO_ISOLATED_CPU_LIMIT, DEFAULT_CPU_LIMIT, MAX_CPU_LIMIT),
    pidsLimit: Math.floor(
      numberFromEnv(env.KORRELO_ISOLATED_PIDS_LIMIT, DEFAULT_PIDS_LIMIT, MAX_PIDS_LIMIT),
    ),
    reason: "projeto de laboratório isolado; sem rede compartilhada",
  };
}
