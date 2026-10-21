"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  X,
  WifiOff,
  Hourglass,
  PauseCircle,
  RotateCw,
} from "lucide-react";
import {
  apiFetch,
  backoffDelay,
  isAuthFailure,
  isNetworkError,
  isTransientServerError,
} from "../../../lib/api-client";
import { useTranslation } from "../../../lib/i18n/locale-provider";
import { dismissSelfUpdateJob } from "../../../lib/self-update-dismiss-store";
import {
  decideNextPoll,
  decidePhase,
  detectWaitingFromLog,
  formatElapsed,
  monotonicPercent,
  pickRelevantLogLines,
  stageLabelKey,
  type UpdateViewPhase,
} from "../../../lib/self-update-view";

interface SelfUpdateJob {
  id: string;
  status: string;
  progress: number;
  currentStage: string | null;
  previousCommit: string | null;
  candidateCommit: string | null;
  recoveryStatus: string | null;
  failureReason: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

interface SelfUpdateCurrent {
  running: boolean;
  percent: number;
  label: string;
  done: boolean;
  success: boolean | null;
  errorMessage?: string;
  log: string;
  jobId?: string | null;
  jobStatus?: string | null;
  currentStage?: string | null;
  previousCommit?: string | null;
  candidateCommit?: string | null;
  recoveryStatus?: string | null;
  interrupted?: boolean;
  job?: SelfUpdateJob | null;
  /** O executor está aguardando recursos da VPS. */
  waiting?: boolean;
  /** Detalhes medidos pelo executor (swap/load/MemAvailable...). */
  waitingDetails?: string[] | null;
  /** "próxima checagem em Ns". */
  nextRetryInSeconds?: number | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  progress?: number;
  lastMessage?: string | null;
}

const STATUS_POLL_MS = 1000;
const HEALTH_POLL_MS = 1500;
const HEALTH_TIMEOUT_MS = 120_000;
/** Tick do relógio local (tempo decorrido) - não consulta o backend. */
const ELAPSED_TICK_MS = 1000;
/** Quantidade de linhas em "Atividade recente". */
const ACTIVITY_LINES = 20;

export function UpdateProgressModal({ onClose, jobId }: { onClose: () => void; jobId?: string }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<UpdateViewPhase>("running");
  const [percent, setPercent] = useState(0);
  const [label, setLabel] = useState("");
  const [log, setLog] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [previousCommit, setPreviousCommit] = useState<string | null>(null);
  const [candidateCommit, setCandidateCommit] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [finishedAt, setFinishedAt] = useState<string | null>(null);
  /** ID do job em acompanhamento (para marcar o dismiss). */
  const [currentJobId, setCurrentJobId] = useState<string | undefined>(jobId);
  const [waiting, setWaiting] = useState(false);
  const [waitingDetails, setWaitingDetails] = useState<string[] | null>(null);
  const [nextRetryInSeconds, setNextRetryInSeconds] = useState<number | null>(null);
  /** Relógio local: só para o tempo decorrido (sem chamar o backend). */
  const [now, setNow] = useState(() => Date.now());
  const logBoxRef = useRef<HTMLPreElement>(null);
  /** Percentual já visto (a barra nunca regride). */
  const percentRef = useRef(0);
  /** Evita o reload automático (o requisito é dar feedback visual primeiro). */
  const [reloading, setReloading] = useState(false);

  // Relógio local: o "tempo decorrido" anda sem consultar o backend.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let statusTimer: ReturnType<typeof setTimeout> | undefined;
    let healthTimer: ReturnType<typeof setTimeout> | undefined;
    let healthDeadline = 0;
    let attempt = 0;

    async function pollStatus() {
      try {
        const res = await apiFetch("/monitoring/self-update/current");
        if (cancelled) return;

        // 5xx = API reiniciando (transitório). Não é sessão inválida.
        if (isTransientServerError(res)) {
          attempt += 1;
          scheduleStatus(backoffDelay(attempt));
          return;
        }
        // 401 real = sessão inválida de verdade.
        if (isAuthFailure(res)) {
          window.location.href = "/login";
          return;
        }
        if (!res.ok) {
          attempt += 1;
          scheduleStatus(backoffDelay(attempt));
          return;
        }

        attempt = 0;
        const data: SelfUpdateCurrent = await res.json();
        if (cancelled) return;

        // O progresso NUNCA regride (o executor pode emitir steps fora de
        // ordem numérica - a barra não pode voltar atrás).
        const incoming = data.progress ?? data.percent ?? 0;
        const nextPercent = monotonicPercent(percentRef.current, incoming);
        percentRef.current = nextPercent;
        setPercent(nextPercent);
        setLabel(data.label ?? "");
        setLog(data.log ?? "");
        setStage(data.currentStage ?? data.job?.currentStage ?? null);
        setPreviousCommit(data.previousCommit ?? data.job?.previousCommit ?? null);
        setCandidateCommit(data.candidateCommit ?? data.job?.candidateCommit ?? null);
        setStartedAt(data.startedAt ?? data.job?.startedAt ?? null);
        setFinishedAt(data.finishedAt ?? data.job?.finishedAt ?? null);
        setCurrentJobId(data.jobId ?? data.job?.id ?? jobId);

        const jobStatus = data.jobStatus ?? data.job?.status ?? null;
        // A espera por recursos: o backend é a fonte da verdade; se ele for
        // uma versão antiga, o frontend infere do mesmo log.
        const isWaiting =
          data.waiting === true || (data.waiting === undefined && detectWaitingFromLog(data.log ?? ""));
        setWaiting(isWaiting);
        setWaitingDetails(data.waitingDetails ?? null);
        setNextRetryInSeconds(data.nextRetryInSeconds ?? null);

        if (data.interrupted || jobStatus === "interrupted") {
          setErrorMessage(data.errorMessage ?? data.job?.failureReason ?? null);
          setPhase("interrupted");
          return;
        }

        // O que fazer DEPOIS de ler o estado. Enquanto o job estiver em
        // andamento, a consulta é RE-AGENDADA - é isso que faz a UI
        // acompanhar o update em vez de congelar na primeira leitura.
        const next = decideNextPoll({
          done: data.done,
          success: data.success,
          interrupted: data.interrupted,
        });
        if (next === "wait-health") {
          setPhase("restarting");
          healthDeadline = Date.now() + HEALTH_TIMEOUT_MS;
          scheduleHealth();
          return;
        }
        if (next === "stop") {
          setErrorMessage(data.errorMessage ?? data.job?.failureReason ?? null);
          setPhase("failed");
          return;
        }

        setPhase(
          decidePhase({
            done: data.done,
            success: data.success,
            interrupted: data.interrupted,
            waiting: isWaiting,
            reconnecting: false,
          }),
        );
        scheduleStatus(STATUS_POLL_MS);
      } catch (error) {
        if (cancelled) return;
        // Erro de rede: a API reiniciou (é o próprio update reiniciando a
        // API). NÃO é "não autenticado": mostra reconectando e tenta de novo.
        if (isNetworkError(error)) {
          attempt += 1;
          setPhase((current) =>
            current === "failed" || current === "success" || current === "interrupted"
              ? current
              : "reconnecting",
          );
          scheduleStatus(backoffDelay(attempt));
          return;
        }
        attempt += 1;
        scheduleStatus(backoffDelay(attempt));
      }
    }

    function scheduleStatus(delayMs: number) {
      if (cancelled) return;
      statusTimer = setTimeout(pollStatus, delayMs);
    }

    async function pollHealth() {
      if (Date.now() > healthDeadline) {
        setErrorMessage(t.dashboard.updateStartFailed);
        setPhase("failed");
        return;
      }
      try {
        const res = await apiFetch("/auth/has-user");
        if (res.ok && !cancelled) {
          setPhase("success");
          return;
        }
      } catch {
        // Esperado enquanto o PM2 ainda está religando os processos.
      }
      scheduleHealth();
    }

    function scheduleHealth() {
      if (cancelled) return;
      healthTimer = setTimeout(pollHealth, HEALTH_POLL_MS);
    }

    pollStatus();

    return () => {
      cancelled = true;
      if (statusTimer) clearTimeout(statusTimer);
      if (healthTimer) clearTimeout(healthTimer);
    };
  }, [t, jobId]);

  const activityLines = useMemo(() => pickRelevantLogLines(log, ACTIVITY_LINES), [log]);

  useEffect(() => {
    logBoxRef.current?.scrollTo({ top: logBoxRef.current.scrollHeight });
  }, [activityLines]);

  const displayPercent = phase === "success" ? 100 : percent;
  const stageKey = stageLabelKey(stage);
  const stageLabel = stageKey ? (t.dashboard.updateStages[stageKey] ?? stage) : stage;
  const elapsed = formatElapsed(startedAt, now);
  const duration = formatElapsed(startedAt, finishedAt ? Date.parse(finishedAt) : now);

  const stateBadge = () => {
    if (phase === "success") {
      return { text: t.dashboard.updateStateSuccess, className: "text-accent", Icon: CheckCircle2 };
    }
    if (phase === "failed" || phase === "interrupted") {
      return { text: t.dashboard.updateStateFailed, className: "text-destructive", Icon: XCircle };
    }
    if (phase === "waiting") {
      return { text: t.dashboard.updateStateWaiting, className: "text-amber-500", Icon: Hourglass };
    }
    if (phase === "reconnecting") {
      return { text: t.dashboard.updateReconnectingTitle, className: "text-muted-foreground", Icon: WifiOff };
    }
    return { text: t.dashboard.updateStateRunning, className: "text-accent", Icon: Loader2 };
  };

  const badge = stateBadge();
  const BadgeIcon = badge.Icon;

  const title = () => {
    if (phase === "failed") return t.dashboard.updateFailedTitle;
    if (phase === "interrupted") return t.dashboard.updateInterruptedTitle;
    if (phase === "reconnecting") return t.dashboard.updateReconnectingTitle;
    if (phase === "restarting") return t.dashboard.updateRestartingTitle;
    if (phase === "success") return t.dashboard.updateDoneTitle;
    if (phase === "waiting") return t.dashboard.updateWaitingTitle;
    return stageLabel || label || t.dashboard.updateNowButton;
  };

  const canClose = phase === "failed" || phase === "interrupted" || phase === "success";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4">
      <div className="flex max-h-[96vh] w-full flex-col rounded-t-2xl border border-border-subtle bg-surface shadow-panel sm:max-h-[90vh] sm:max-w-3xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3 p-4 sm:p-6">
          <div className="flex min-w-0 items-start gap-2.5">
            {phase === "failed" || phase === "interrupted" ? (
              <XCircle size={20} className="mt-0.5 flex-none text-destructive" />
            ) : phase === "success" ? (
              <CheckCircle2 size={20} className="mt-0.5 flex-none text-accent" />
            ) : phase === "reconnecting" ? (
              <WifiOff size={20} className="mt-0.5 flex-none text-muted-foreground" />
            ) : phase === "waiting" ? (
              <PauseCircle size={20} className="mt-0.5 flex-none text-amber-500" />
            ) : phase === "restarting" ? (
              <RotateCw size={20} className="mt-0.5 flex-none animate-spin text-accent" />
            ) : (
              <Loader2 size={20} className="mt-0.5 flex-none animate-spin text-accent" />
            )}
            <div className="min-w-0">
              <h2 className="truncate text-[15px] font-semibold text-foreground">{title()}</h2>
              {/* O estado é TEXTO + ícone (não só cor). */}
              <p className={`mt-1 flex items-center gap-1.5 text-[12px] font-semibold ${badge.className}`}>
                <BadgeIcon
                  size={12}
                  className={phase === "running" || phase === "restarting" ? "animate-spin" : ""}
                />
                {badge.text}
              </p>
            </div>
          </div>
          {canClose && (
            <button
              onClick={() => {
                dismissSelfUpdateJob(currentJobId);
                onClose();
              }}
              aria-label={t.dashboard.updateCloseButton}
              className="flex-none text-muted-foreground hover:text-foreground"
            >
              <X size={16} />
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 sm:px-6 sm:pb-6">
          {/* ETAPA ATUAL + tempo decorrido */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border-subtle bg-background px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {t.dashboard.updateStageLabel}
              </p>
              <p className="mt-0.5 truncate text-[13px] font-medium text-foreground" title={stageLabel ?? ""}>
                {stageLabel || "-"}
              </p>
            </div>
            <div className="rounded-lg border border-border-subtle bg-background px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {t.dashboard.updateElapsedLabel}
              </p>
              <p className="mt-0.5 font-mono text-[13px] font-medium text-foreground">
                {elapsed || "-"}
              </p>
            </div>
            <div className="rounded-lg border border-border-subtle bg-background px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {t.dashboard.updateStateLabel}
              </p>
              <p className={`mt-0.5 text-[13px] font-medium ${badge.className}`}>{badge.text}</p>
            </div>
          </div>

          {/* PROGRESSO */}
          <div className="mt-4">
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  phase === "failed" || phase === "interrupted" ? "bg-destructive" : "bg-accent"
                }`}
                style={{ width: `${displayPercent}%` }}
              />
            </div>
            <p className="mt-1.5 text-right font-mono text-[12px] text-muted-foreground">
              {displayPercent}%
            </p>
          </div>

          {/* AGUARDANDO RECURSOS - o operador vê que NÃO está travado */}
          {phase === "waiting" && (
            <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
              <p className="text-[13px] font-semibold text-amber-500">
                {t.dashboard.updateWaitingTitle}
              </p>
              <p className="mt-1 text-[12.5px] text-muted-foreground">
                {t.dashboard.updateWaitingSubtitle}
              </p>
              {waitingDetails && waitingDetails.length > 0 && (
                <ul className="mt-2 space-y-0.5">
                  {waitingDetails.map((detail, index) => (
                    <li key={`${detail}-${index}`} className="font-mono text-[12px] text-foreground">
                      {detail}
                    </li>
                  ))}
                </ul>
              )}
              {nextRetryInSeconds !== null && (
                <p className="mt-2 text-[12.5px] text-muted-foreground">
                  {t.dashboard.updateWaitingNextRetry}: {nextRetryInSeconds}s
                </p>
              )}
            </div>
          )}

          {phase === "reconnecting" && (
            <p className="mt-3 text-[13px] text-muted-foreground">
              {t.dashboard.updateReconnectingSubtitle}
            </p>
          )}
          {phase === "restarting" && (
            <p className="mt-3 text-[13px] text-muted-foreground">
              {t.dashboard.updateRestartingSubtitle}
            </p>
          )}
          {phase === "success" && (
            <div className="mt-4 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2.5">
              <p className="text-[13px] font-semibold text-accent">{t.dashboard.updateDoneTitle}</p>
              {duration && (
                <p className="mt-1 text-[12.5px] text-muted-foreground">
                  {t.dashboard.updateDurationLabel}: {duration}
                </p>
              )}
            </div>
          )}
          {(phase === "failed" || phase === "interrupted") && (
            <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5">
              {stage && (
                <p className="text-[12.5px] text-muted-foreground">
                  {t.dashboard.updateFailedStageLabel}:{" "}
                  <span className="font-medium text-foreground">{stageLabel}</span>
                </p>
              )}
              {errorMessage && (
                <p className="mt-1 break-words text-[13px] text-destructive">{errorMessage}</p>
              )}
              <p className="mt-1 text-[12.5px] text-muted-foreground">
                {t.dashboard.updateProductionIntact}
              </p>
            </div>
          )}

          {(stage || previousCommit || candidateCommit) && (
            <div className="mt-3 space-y-1 text-[12px] text-muted-foreground">
              {previousCommit && (
                <p>
                  {t.dashboard.updatePreviousVersion}:{" "}
                  <span className="font-mono">{previousCommit.slice(0, 8)}</span>
                </p>
              )}
              {candidateCommit && (
                <p>
                  {t.dashboard.updateCandidateVersion}:{" "}
                  <span className="font-mono">{candidateCommit.slice(0, 8)}</span>
                </p>
              )}
            </div>
          )}

          {/* ATIVIDADE RECENTE */}
          <p className="mb-1.5 mt-4 text-[12px] font-medium text-muted-foreground">
            {t.dashboard.updateActivityTitle}
          </p>
          {activityLines.length === 0 ? (
            <p className="rounded-lg bg-background p-3 text-[12.5px] text-muted-foreground">
              {t.dashboard.updateActivityEmpty}
            </p>
          ) : (
            <pre
              ref={logBoxRef}
              className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-background p-3 font-mono text-[11.5px] leading-relaxed text-foreground"
            >
              {activityLines.join("\n")}
            </pre>
          )}
        </div>

        {/* AÇÕES */}
        <div className="flex flex-col gap-2 border-t border-border-subtle p-4 sm:flex-row sm:justify-end sm:px-6">
          {phase === "success" && (
            <button
              onClick={() => {
                // Marca o dismiss ANTES de recarregar: senão o watcher
                // encontra o job terminal recente e reabre o modal, e o
                // operador fica preso vendo o mesmo resultado.
                dismissSelfUpdateJob(currentJobId);
                setReloading(true);
                window.location.reload();
              }}
              disabled={reloading}
              className="w-full rounded-md bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-accent-foreground hover:opacity-90 disabled:opacity-60 sm:w-auto"
            >
              {t.dashboard.updateReloadDashboard}
            </button>
          )}
          {canClose && (
            <button
              onClick={() => {
                // Mesmo aqui: o operador já viu o resultado, então o job
                // não deve reabrir no próximo poll/reload.
                dismissSelfUpdateJob(currentJobId);
                onClose();
              }}
              className="w-full rounded-md border border-border-subtle px-4 py-2.5 text-[13.5px] font-medium text-foreground hover:bg-muted sm:w-auto"
            >
              {t.dashboard.updateCloseButton}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
