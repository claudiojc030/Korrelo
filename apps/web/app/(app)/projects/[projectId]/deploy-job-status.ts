/**
 * Tradução do estado bruto do DeployJob (API) para o que o operador vê.
 *
 * Puro de propósito: o painel não interpreta strings de log nem supõe
 * sucesso. Um job só é "concluído" quando o status persistido é succeeded.
 */

export type DeployJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "canceled";

export interface DeployJobShadowView {
  basis: "conservative-fallback" | "observed-peak";
  requiredMb: number;
  savedMb: number;
  confidence: string;
  samples: number;
  samplingIntervalSeconds?: number;
  observedPeakMb: number | null;
  reason: string | null;
  simulation?: boolean;
}

export interface DeployJobResourceCheckView {
  availableMemoryMb: number | null;
  requiredMemoryMb: number | null;
  productionLimitMb: number | null;
  productionUsageMb: number | null;
  shadow: DeployJobShadowView | null;
}

export interface DeployJobRuntimeView {
  paused: boolean;
  waitingForResources: boolean;
  nextAttemptAt: string | null;
  maxResourceAttempts: number;
  resourceCheck?: DeployJobResourceCheckView | null;
}

export interface DeployJobView {
  id: string;
  projectId: string;
  status: DeployJobStatus;
  trigger: string;
  stage: string | null;
  attempt: number;
  errorMessage: string | null;
  commitSha: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  runtime?: DeployJobRuntimeView;
}

export type DeployJobPhase =
  | "received"
  | "waiting-resources"
  | "paused"
  | "starting"
  | "fetching"
  | "building"
  | "staging"
  | "promoting"
  | "succeeded"
  | "failed"
  | "canceled"
  | "interrupted";

export interface DeployJobDescription {
  phase: DeployJobPhase;
  /** Job ainda pode mudar sozinho (o painel deve continuar atualizando). */
  active: boolean;
  /** Job em estado final persistido. */
  terminal: boolean;
  /** Só solicitação na fila pode ser cancelada. Build em execução, nunca. */
  canCancel: boolean;
  /** Pausado no startup: exige retomada explícita. */
  canResume: boolean;
  /** Número máximo de tentativas por recursos (quando aplicável). */
  maxAttempts: number | null;
}

const PROMOTING_STAGES = new Set(["promote", "production-health", "rollback", "complete"]);
const STAGING_STAGES = new Set(["staging-start", "staging-health"]);
const BUILDING_STAGES = new Set(["building", "build"]);

/**
 * Formata datas no fuso de São Paulo de forma DETERMINÍSTICA.
 *
 * `toLocaleString` depende do fuso do processo: no SSR (UTC) e no browser
 * (America/Sao_Paulo) o texto sai diferente e o React acusa erro de
 * hidratação (#418). Aqui os componentes são extraídos com `formatToParts`
 * e montados manualmente — a mesma string nos dois lados.
 */
const SAO_PAULO_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function parts(iso: string): Record<string, string> | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const entries = SAO_PAULO_PARTS.formatToParts(date).map((part) => [part.type, part.value]);
  return Object.fromEntries(entries);
}

/** dd/mm/aaaa hh:mm:ss (America/Sao_Paulo), ou o ISO original se inválido. */
export function formatDeployDateTime(iso: string): string {
  const value = parts(iso);
  if (!value) return iso;
  return `${value.day}/${value.month}/${value.year} ${value.hour}:${value.minute}:${value.second}`;
}

/** hh:mm (America/Sao_Paulo), ou "—" se inválido. */
export function formatDeployTime(iso: string): string {
  const value = parts(iso);
  if (!value) return "—";
  return `${value.hour}:${value.minute}`;
}

export function describeDeployJob(job: DeployJobView): DeployJobDescription {  const runtime = job.runtime;
  const maxAttempts = runtime?.maxResourceAttempts ?? null;

  if (job.status === "succeeded") {
    return { phase: "succeeded", active: false, terminal: true, canCancel: false, canResume: false, maxAttempts };
  }
  if (job.status === "failed") {
    return { phase: "failed", active: false, terminal: true, canCancel: false, canResume: false, maxAttempts };
  }
  if (job.status === "canceled") {
    return { phase: "canceled", active: false, terminal: true, canCancel: false, canResume: false, maxAttempts };
  }
  if (job.status === "interrupted") {
    return { phase: "interrupted", active: false, terminal: true, canCancel: false, canResume: false, maxAttempts };
  }

  if (job.status === "running") {
    const stage = job.stage ?? "";
    const phase: DeployJobPhase = PROMOTING_STAGES.has(stage)
      ? "promoting"
      : STAGING_STAGES.has(stage)
        ? "staging"
        : BUILDING_STAGES.has(stage)
          ? "building"
          : "starting";
    return { phase, active: true, terminal: false, canCancel: false, canResume: false, maxAttempts };
  }

  // queued
  if (runtime?.paused) {
    return { phase: "paused", active: false, terminal: false, canCancel: true, canResume: true, maxAttempts };
  }
  if (runtime?.waitingForResources || job.stage === "waiting-resources") {
    return { phase: "waiting-resources", active: true, terminal: false, canCancel: true, canResume: false, maxAttempts };
  }
  if (job.stage === "fetching") {
    return { phase: "fetching", active: true, terminal: false, canCancel: true, canResume: false, maxAttempts };
  }
  return { phase: "received", active: true, terminal: false, canCancel: true, canResume: false, maxAttempts };
}
