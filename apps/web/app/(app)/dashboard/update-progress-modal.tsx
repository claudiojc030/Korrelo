"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, CheckCircle2, XCircle, X } from "lucide-react";
import { apiFetch } from "../../../lib/api-client";
import { useTranslation } from "../../../lib/i18n/locale-provider";

interface SelfUpdateStatus {
  running: boolean;
  percent: number;
  label: string;
  done: boolean;
  success: boolean | null;
  errorMessage?: string;
  log: string;
}

type Phase = "updating" | "restarting" | "done" | "failed";

const STATUS_POLL_MS = 1000;
const HEALTH_POLL_MS = 1500;
const HEALTH_TIMEOUT_MS = 90_000;

export function UpdateProgressModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("updating");
  const [percent, setPercent] = useState(0);
  const [label, setLabel] = useState("");
  const [log, setLog] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const logBoxRef = useRef<HTMLPreElement>(null);
  const phaseRef = useRef<Phase>("updating");
  phaseRef.current = phase;

  useEffect(() => {
    let cancelled = false;
    let statusTimer: ReturnType<typeof setInterval> | undefined;
    let healthTimer: ReturnType<typeof setInterval> | undefined;
    let healthDeadline = 0;

    async function pollStatus() {
      try {
        const res = await apiFetch("/monitoring/update/status");
        if (!res.ok || cancelled) return;
        const data: SelfUpdateStatus = await res.json();
        if (cancelled) return;

        setPercent(data.percent);
        setLabel(data.label);
        setLog(data.log);

        if (data.done && phaseRef.current === "updating") {
          if (data.success) {
            if (statusTimer) clearInterval(statusTimer);
            setPhase("restarting");
            healthDeadline = Date.now() + HEALTH_TIMEOUT_MS;
            healthTimer = setInterval(pollHealth, HEALTH_POLL_MS);
          } else {
            if (statusTimer) clearInterval(statusTimer);
            setErrorMessage(data.errorMessage ?? null);
            setPhase("failed");
          }
        }
      } catch {
        // A API pode estar momentaneamente fora do ar (ex.: durante o build
        // da própria API); ignora e tenta de novo no próximo tick.
      }
    }

    async function pollHealth() {
      if (Date.now() > healthDeadline) {
        if (healthTimer) clearInterval(healthTimer);
        setErrorMessage(t.dashboard.updateStartFailed);
        setPhase("failed");
        return;
      }
      try {
        const res = await apiFetch("/auth/has-user");
        if (res.ok && !cancelled) {
          if (healthTimer) clearInterval(healthTimer);
          setPhase("done");
          setTimeout(() => window.location.reload(), 1200);
        }
      } catch {
        // Esperado enquanto o PM2 ainda está religando os processos.
      }
    }

    statusTimer = setInterval(pollStatus, STATUS_POLL_MS);
    pollStatus();

    return () => {
      cancelled = true;
      if (statusTimer) clearInterval(statusTimer);
      if (healthTimer) clearInterval(healthTimer);
    };
  }, [t]);

  useEffect(() => {
    logBoxRef.current?.scrollTo({ top: logBoxRef.current.scrollHeight });
  }, [log]);

  const displayPercent = phase === "done" ? 100 : percent;
  const visibleLog = log
    .split("\n")
    .filter((line) => !line.startsWith("__KORRELO_UPDATE_"))
    .join("\n");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="w-full max-w-lg rounded-xl border border-border-subtle bg-surface p-6 shadow-panel">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {phase === "failed" ? (
              <XCircle size={18} className="flex-none text-destructive" />
            ) : phase === "done" ? (
              <CheckCircle2 size={18} className="flex-none text-accent" />
            ) : (
              <Loader2 size={18} className="flex-none animate-spin text-accent" />
            )}
            <h2 className="truncate text-[14.5px] font-semibold text-foreground">
              {phase === "failed"
                ? t.dashboard.updateFailedTitle
                : phase === "restarting"
                  ? t.dashboard.updateRestartingTitle
                  : phase === "done"
                    ? t.dashboard.updateDoneTitle
                    : label || t.dashboard.updateNowButton}
            </h2>
          </div>
          {phase === "failed" && (
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
            className={`h-full rounded-full transition-all duration-500 ${phase === "failed" ? "bg-destructive" : "bg-accent"}`}
            style={{ width: `${displayPercent}%` }}
          />
        </div>
        <p className="mt-1.5 text-right font-mono text-[12px] text-muted-foreground">{displayPercent}%</p>

        {phase === "restarting" && (
          <p className="mt-1 text-[13px] text-muted-foreground">{t.dashboard.updateRestartingSubtitle}</p>
        )}
        {phase === "done" && <p className="mt-1 text-[13px] text-muted-foreground">{t.dashboard.updateDoneSubtitle}</p>}
        {phase === "failed" && errorMessage && <p className="mt-1 text-[13px] text-destructive">{errorMessage}</p>}

        <p className="mb-1.5 mt-4 text-[12px] font-medium text-muted-foreground">{t.dashboard.updateLogLabel}</p>
        <pre
          ref={logBoxRef}
          className="h-56 overflow-y-auto rounded-lg bg-background p-3 font-mono text-[11.5px] leading-relaxed text-foreground"
        >
          {visibleLog}
        </pre>

        {phase === "failed" && (
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
