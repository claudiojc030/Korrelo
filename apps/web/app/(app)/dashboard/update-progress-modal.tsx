"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, CheckCircle2, XCircle, X, WifiOff } from "lucide-react";
import {
  apiFetch,
  backoffDelay,
  isAuthFailure,
  isNetworkError,
  isTransientServerError,
} from "../../../lib/api-client";
import { useTranslation } from "../../../lib/i18n/locale-provider";

interface SelfUpdateJob {
  id: string;
  status: string;
  progress: number;
  currentStage: string | null;
  previousCommit: string | null;
  candidateCommit: string | null;
  recoveryStatus: string | null;
  failureReason: string | null;
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
}

type Phase = "updating" | "reconnecting" | "restarting" | "done" | "failed" | "interrupted";

const STATUS_POLL_MS = 1000;
const HEALTH_POLL_MS = 1500;
const HEALTH_TIMEOUT_MS = 120_000;

/**
 * Painel do SELF-UPDATE DESACOPLADO (Wave 3).
 *
 * O update NÃO depende mais do terminal/WebSocket: o backend dispara um
 * processo detached e este painel apenas CONSULTA o estado (polling). Se a
 * API reiniciar no meio (o próprio update reinicia a API!), o painel mostra
 * "reconectando" e volta sozinho - sem virar "Não autenticado".
 *
 * O estado é recuperado do backend (GET /monitoring/self-update/current),
 * então recarregar a página não perde o acompanhamento.
 */
export function UpdateProgressModal({ onClose, jobId }: { onClose: () => void; jobId?: string }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("updating");
  const [percent, setPercent] = useState(0);
  const [label, setLabel] = useState("");
  const [log, setLog] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [previousCommit, setPreviousCommit] = useState<string | null>(null);
  const [candidateCommit, setCandidateCommit] = useState<string | null>(null);
  const logBoxRef = useRef<HTMLPreElement>(null);
  const phaseRef = useRef<Phase>("updating");

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

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

        setPercent(data.percent ?? 0);
        setLabel(data.label ?? "");
        setLog(data.log ?? "");
        setStage(data.currentStage ?? data.job?.currentStage ?? null);
        setPreviousCommit(data.previousCommit ?? data.job?.previousCommit ?? null);
        setCandidateCommit(data.candidateCommit ?? data.job?.candidateCommit ?? null);

        const jobStatus = data.jobStatus ?? data.job?.status ?? null;

        if (data.interrupted || jobStatus === "interrupted") {
          setErrorMessage(data.errorMessage ?? data.job?.failureReason ?? null);
          setPhase("interrupted");
          return;
        }

        if (data.done && phaseRef.current !== "restarting" && phaseRef.current !== "done") {
          if (data.success) {
            setPhase("restarting");
            healthDeadline = Date.now() + HEALTH_TIMEOUT_MS;
            scheduleHealth();
          } else {
            setErrorMessage(data.errorMessage ?? null);
            setPhase("failed");
          }
        }
      } catch (error) {
        if (cancelled) return;
        // Erro de rede: a API reiniciou (é o próprio update reiniciando a
        // API). NÃO é "não autenticado": mostra reconectando e tenta de novo.
        if (isNetworkError(error)) {
          attempt += 1;
          setPhase((current) => (current === "failed" || current === "done" ? current : "reconnecting"));
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
          setPhase("done");
          setTimeout(() => window.location.reload(), 1200);
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

  useEffect(() => {
    logBoxRef.current?.scrollTo({ top: logBoxRef.current.scrollHeight });
  }, [log]);

  const displayPercent = phase === "done" ? 100 : percent;
  const visibleLog = log
    .split("\n")
    .filter((line) => !line.startsWith("__KORRELO_UPDATE_"))
    .join("\n");

  const title = () => {
    if (phase === "failed") return t.dashboard.updateFailedTitle;
    if (phase === "interrupted") return t.dashboard.updateInterruptedTitle;
    if (phase === "reconnecting") return t.dashboard.updateReconnectingTitle;
    if (phase === "restarting") return t.dashboard.updateRestartingTitle;
    if (phase === "done") return t.dashboard.updateDoneTitle;
    return label || t.dashboard.updateNowButton;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="w-full max-w-lg rounded-xl border border-border-subtle bg-surface p-6 shadow-panel">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {phase === "failed" || phase === "interrupted" ? (
              <XCircle size={18} className="flex-none text-destructive" />
            ) : phase === "done" ? (
              <CheckCircle2 size={18} className="flex-none text-accent" />
            ) : phase === "reconnecting" ? (
              <WifiOff size={18} className="flex-none text-muted-foreground" />
            ) : (
              <Loader2 size={18} className="flex-none animate-spin text-accent" />
            )}
            <h2 className="truncate text-[14.5px] font-semibold text-foreground">{title()}</h2>
          </div>
          {(phase === "failed" || phase === "interrupted") && (
            <button
              onClick={onClose}
              aria-label={t.dashboard.updateCloseButton}
              className="flex-none text-muted-foreground hover:text-foreground"
            >
              <X size={16} />
            </button>
          )}
        </div>

        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              phase === "failed" || phase === "interrupted" ? "bg-destructive" : "bg-accent"
            }`}
            style={{ width: `${displayPercent}%` }}
          />
        </div>
        <p className="mt-1.5 text-right font-mono text-[12px] text-muted-foreground">{displayPercent}%</p>

        {phase === "reconnecting" && (
          <p className="mt-1 text-[13px] text-muted-foreground">{t.dashboard.updateReconnectingSubtitle}</p>
        )}
        {phase === "restarting" && (
          <p className="mt-1 text-[13px] text-muted-foreground">{t.dashboard.updateRestartingSubtitle}</p>
        )}
        {phase === "done" && <p className="mt-1 text-[13px] text-muted-foreground">{t.dashboard.updateDoneSubtitle}</p>}
        {(phase === "failed" || phase === "interrupted") && errorMessage && (
          <p className="mt-1 text-[13px] text-destructive">{errorMessage}</p>
        )}
        {(phase === "failed" || phase === "interrupted") && (
          <p className="mt-1 text-[13px] text-muted-foreground">{t.dashboard.updateProductionIntact}</p>
        )}

        {(stage || previousCommit || candidateCommit) && (
          <div className="mt-3 space-y-1 text-[12px] text-muted-foreground">
            {stage && (
              <p>
                {t.dashboard.updateStageLabel}: <span className="font-mono">{stage}</span>
              </p>
            )}
            {previousCommit && (
              <p>
                {t.dashboard.updatePreviousVersion}: <span className="font-mono">{previousCommit.slice(0, 8)}</span>
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

        <p className="mb-1.5 mt-4 text-[12px] font-medium text-muted-foreground">{t.dashboard.updateLogLabel}</p>
        <pre
          ref={logBoxRef}
          className="h-56 overflow-y-auto rounded-lg bg-background p-3 font-mono text-[11.5px] leading-relaxed text-foreground"
        >
          {visibleLog}
        </pre>

        {(phase === "failed" || phase === "interrupted") && (
          <button
            onClick={onClose}
            className="mt-4 w-full rounded-md bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-accent-foreground hover:opacity-90"
          >
            {t.dashboard.updateCloseButton}
          </button>
        )}
      </div>
    </div>
  );
}
