/**
 * OBSERVABILIDADE DO SELF-UPDATE (view).
 *
 * Funções PURAS (sem React) que transformam o estado do job em informação
 * útil pro operador. Tudo aqui é testável sem navegador.
 *
 * Princípio: NADA é inventado. Se o backend/job não trouxer um número, ele
 * não aparece. As únicas fontes são o job persistido
 * (~/.korrelo/self-update/<id>.json) e o log do runner (<id>.log).
 */

/** Stage do rollout -> chave da tradução (dicionário do dashboard). */
export const STAGE_LABEL_KEYS: Record<string, string> = {
  preflight: "updateStagePreflight",
  lock: "updateStageLock",
  "worker-drain": "updateStageWorkerDrain",
  "git-check": "updateStageGitCheck",
  "resource-preflight": "updateStageResourcePreflight",
  "snapshot-before": "updateStageSnapshotBefore",
  "core-backup": "updateStageCoreBackup",
  "git-update": "updateStageGitUpdate",
  "artifacts-snapshot": "updateStageArtifactsSnapshot",
  install: "updateStageInstall",
  "worktree-check": "updateStageWorktreeCheck",
  "toolchain-check": "updateStageToolchainCheck",
  "build-shared": "updateStageBuildShared",
  "build-api": "updateStageBuildApi",
  "build-web": "updateStageBuildWeb",
  "web-assets": "updateStageWebAssets",
  migration: "updateStageMigration",
  permissions: "updateStagePermissions",
  "pm2-restart": "updateStagePm2Restart",
  "health-core": "updateStageHealthCore",
  "snapshot-after": "updateStageSnapshotAfter",
  "compare-projects": "updateStageCompareProjects",
  "git-verify": "updateStageGitVerify",
  "worker-release": "updateStageWorkerRelease",
  complete: "updateStageComplete",
};

/**
 * Chave da tradução de um stage. Devolve null para stage desconhecido (a UI
 * mostra o id cru - melhor do que mentir).
 */
export function stageLabelKey(stage: string | null | undefined): string | null {
  if (!stage) return null;
  return STAGE_LABEL_KEYS[stage] ?? null;
}

/**
 * "2m 14s" - tempo decorrido desde o início do job.
 *
 * O relógio é do CLIENTE: a UI atualiza a cada segundo sem consultar o
 * backend (o jobStartedAt é o mesmo do backend).
 */
export function formatElapsed(startedAt: string | null | undefined, now: number = Date.now()): string {
  if (!startedAt) return "";
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return "";
  const totalSeconds = Math.max(0, Math.floor((now - started) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * O progresso NUNCA regride.
 *
 * O executor pode emitir steps fora de ordem numérica (um stage de
 * verificação roda depois de um de build, por exemplo). A barra não pode
 * "voltar atrás" - isso faria o operador achar que o update regrediu.
 */
export function monotonicPercent(previous: number, incoming: number): number {
  if (!Number.isFinite(incoming)) return previous;
  const value = Math.max(0, Math.min(100, Math.round(incoming)));
  return Math.max(previous, value);
}

/**
 * Remove segredos de uma linha de log.
 *
 * O log do rollout é do próprio Core (não tem env dump), mas o filtro é
 * defensivo: nunca mostrar algo que pareça senha/token/chave.
 */
/**
 * Remove segredos de uma linha de log.
 *
 * O log do rollout é do próprio Core (não tem env dump), mas o filtro é
 * defensivo: nunca mostrar algo que pareça senha/token/chave.
 *
 * A ordem importa: os padrões que carregam o segredo INTEIRO (Bearer, PEM,
 * connection string) são aplicados primeiro; depois os de "chave=valor".
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  // Bearer / chaves privadas PEM
  /\bBearer\s+[A-Za-z0-9._-]{8,}[^\n]*/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // connection strings com credencial
  /\b(mongodb(?:\+srv)?|postgres(?:ql)?|redis):\/\/[^\s"']+:\S+@[^\s"']+/gi,
];

const SECRET_KEY_PATTERNS: RegExp[] = [
  // chave=valor onde a chave parece um segredo
  /((?:SECRET|TOKEN|PASSWORD|PASSWD|PASS|CREDENTIAL|PRIVATE_KEY|API_KEY|AUTH|COOKIE|SESSION)[A-Z_]*)\s*=\s*\S+/gi,
  // "chave: valor" (mesmos nomes de chave, com dois-pontos). Consome o resto
  // da linha: "Authorization: Bearer abc" não pode deixar o token de fora.
  /((?:SECRET|TOKEN|PASSWORD|PASSWD|PASS|CREDENTIAL|PRIVATE_KEY|API_KEY|AUTH|COOKIE|SESSION)[A-Z_]*)\s*:[^\n]*/gi,
  // "senha: valor", "token: valor"
  /\b(senha|password|token|secret|chave|credencial)\s*:[^\n]*/gi,
];

/** Devolve a linha sem segredos (ou vazia se não sobrou nada). */
export function sanitizeLogLine(line: string): string {
  let text = String(line ?? "");
  for (const pattern of SECRET_VALUE_PATTERNS) {
    text = text.replace(pattern, "***");
  }
  for (const pattern of SECRET_KEY_PATTERNS) {
    text = text.replace(pattern, (match) => {
      const sep = match.includes("=") ? "=" : ":";
      const key = match.split(sep)[0];
      return `${key}${sep}***`;
    });
  }
  return text;
}

/** Linhas que o operador PRECISA ver (o resto é ruído de build). */
const RELEVANT_PATTERNS: RegExp[] = [
  /\[rollout\]/i,
  /aguardando recursos/i,
  /recursos normalizados/i,
  /aguardando/i,
  /health/i,
  /erro|fail|error|falhou|abort/i,
  /concluíd|concluid|complete|success|finaliz/i,
  /timeout/i,
  /rollback/i,
  /migra|migration/i,
  /backup/i,
  /pm2/i,
];

function isRelevant(line: string): boolean {
  return RELEVANT_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * Uma linha de DETALHE da espera ("swap em uso=601 MB (limite 512)").
 *
 * O resource guard escreve o bloco assim:
 *   [rollout] <label>: aguardando recursos
 *   swap em uso=601 MB (limite 512)     <- medição
 *   load average (1min)=3.19 (limite 1.5)
 *   tentativa=1
 *   próxima checagem em 10s
 *
 * As medições são o que o operador precisa ver (são os números reais do
 * host) - por isso o bloco inteiro entra na atividade recente.
 */
const METRIC_LINE_PATTERN = /^[^\[]+=[^\s].*\(limite\s.+\)$/;

function isWaitBlockDetail(line: string): boolean {
  return METRIC_LINE_PATTERN.test(line) || /^tentativa=\d+$/.test(line) || /próxima checagem em \d+s/.test(line);
}

/**
 * "Atividade recente": as últimas ~20 linhas relevantes do log.
 *
 * Filtros aplicados:
 * - marcadores internos (`__KORRELO_UPDATE_*`) não aparecem (são protocolo
 *   interno entre o runner e a API);
 * - segredos são removidos;
 * - linhas de build（NPM, TypeScript, etc.) são descartadas: o operador quer
 *   o que está ACONTECENDO, não o output do compilador.
 */
export function pickRelevantLogLines(log: string, limit = 20): string[] {
  const all = String(log ?? "")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => !line.startsWith("__KORRELO_UPDATE_"))
    .map((line) => sanitizeLogLine(line).trimEnd())
    .filter((line) => line.length > 0);

  // Uma linha de detalhe da espera só é relevante se pertence a um bloco de
  // espera (imediatamente depois de "aguardando recursos").
  const keep = new Set<number>();
  all.forEach((line, index) => {
    if (isRelevant(line)) keep.add(index);
  });
  all.forEach((line, index) => {
    if (!/aguardando recursos/i.test(line)) return;
    for (let i = index + 1; i < all.length; i += 1) {
      if (all[i].startsWith("[")) break;
      if (isWaitBlockDetail(all[i])) keep.add(i);
    }
  });

  const relevant = all.filter((_, index) => keep.has(index));
  const source = relevant.length > 0 ? relevant : all;
  return source.slice(-limit);
}

/**
 * Fallback do frontend: detecta espera por recursos no log.
 *
 * O BACKEND é a fonte da verdade (ele expõe `waiting`), mas o frontend
 * não fica cego se o backend for uma versão antiga: a mesma leitura do log
 * é feita aqui.
 */
export function detectWaitingFromLog(log: string): boolean {
  const text = String(log ?? "");
  if (!text) return false;
  const lines = text.split("\n");
  let waitIndex = -1;
  let normalizedIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes("aguardando recursos")) waitIndex = i;
    else if (lines[i].includes("recursos normalizados")) normalizedIndex = i;
  }
  if (waitIndex < 0) return false;
  if (normalizedIndex > waitIndex) return false;
  for (let i = waitIndex + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("__KORRELO_UPDATE_STEP__")) return false;
  }
  return true;
}

/** Fases que o modal sabe mostrar. */
export type UpdateViewPhase =
  | "running"
  | "waiting"
  | "reconnecting"
  | "restarting"
  | "success"
  | "failed"
  | "interrupted";

/**
 * Decide a fase mostrada a partir do estado do job.
 *
 * - "waiting" quando o executor está aguardando recursos (NÃO está travado);
 * - "success"/"failed"/"interrupted" quando o job terminou;
 * - "reconnecting" quando a API não responde (o próprio update reinicia ela).
 */
export function decidePhase(input: {
  done: boolean;
  success: boolean | null;
  interrupted?: boolean;
  waiting?: boolean;
  reconnecting?: boolean;
}): UpdateViewPhase {
  if (input.interrupted) return "interrupted";
  if (input.done) return input.success ? "success" : "failed";
  if (input.reconnecting) return "reconnecting";
  if (input.waiting) return "waiting";
  return "running";
}

/** O job terminou (não fica preso em "Atualizando"). */
export function isTerminalStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return ["completed", "failed", "interrupted", "recovery_required", "recovery_deferred"].includes(
    status,
  );
}

/** O job ainda está em andamento (o modal reabre sozinho). */
export function isActiveStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return ["queued", "running", "restarting", "verifying"].includes(status);
}

/**
 * O que o modal deve fazer DEPOIS de ler o estado.
 *
 * - "poll-again": o job continua -> consulta de novo (1s);
 * - "wait-health": o job terminou com sucesso -> espera a API voltar
 *   (é o próprio update que reinicia a API);
 * - "stop": o job terminou (sucesso já tratado ou falha) -> não consulta mais.
 *
 * ESTE É O COMportAMENTO QUE FAZIA A UI PARECER TRAVADA: o modal antigo só
 * re-agendava a consulta nos caminhos de ERRO - no caminho normal (sucesso),
 * o polling terminava depois da primeira resposta e a tela ficava congelada
 * durante toda a espera, mesmo com o rollout seguindo adiante.
 */
export type PollDecision = "poll-again" | "wait-health" | "stop";

export function decideNextPoll(input: {
  done: boolean;
  success: boolean | null;
  interrupted?: boolean;
}): PollDecision {
  if (input.interrupted) return "stop";
  if (!input.done) return "poll-again";
  // Terminou com sucesso: espera a API voltar (a fase "restarting").
  if (input.success) return "wait-health";
  // Terminou com falha: nada mais a consultar.
  return "stop";
}
