"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, CheckCircle2, XCircle, X, TriangleAlert } from "lucide-react";
import { apiFetch } from "../../../../../lib/api-client";
import { useTranslation } from "../../../../../lib/i18n/locale-provider";
import { translateApiError } from "../../../../../lib/api-error";

interface MongoImportStatus {
  running: boolean;
  percent: number;
  label: string;
  done: boolean;
  success: boolean | null;
  errorMessage?: string;
  log: string;
}

type Phase = "form" | "importing" | "done" | "failed";

const STATUS_POLL_MS = 1000;

export function MongoImportModal({
  projectId,
  onClose,
  onImported,
}: {
  projectId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("form");
  const [sourceUri, setSourceUri] = useState("");
  const [starting, setStarting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [percent, setPercent] = useState(0);
  const [label, setLabel] = useState("");
  const [log, setLog] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const logBoxRef = useRef<HTMLPreElement>(null);
  const phaseRef = useRef<Phase>("form");
  const onImportedRef = useRef(onImported);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    onImportedRef.current = onImported;
  }, [onImported]);

  useEffect(() => {
    if (phase !== "importing") return;

    let cancelled = false;
    let statusTimer: ReturnType<typeof setInterval> | undefined;

    async function pollStatus() {
      try {
        const res = await apiFetch(`/projects/${projectId}/database/mongo-import/status`);
        if (!res.ok || cancelled) return;
        const data: MongoImportStatus = await res.json();
        if (cancelled) return;

        setPercent(data.percent);
        setLabel(data.label);
        setLog(data.log);

        if (data.done && phaseRef.current === "importing") {
          if (statusTimer) clearInterval(statusTimer);
          if (data.success) {
            setPhase("done");
            onImportedRef.current();
          } else {
            setErrorMessage(data.errorMessage ?? null);
            setPhase("failed");
          }
        }
      } catch {
        // Ignora e tenta de novo no próximo tick.
      }
    }

    statusTimer = setInterval(pollStatus, STATUS_POLL_MS);
    pollStatus();

    return () => {
      cancelled = true;
      if (statusTimer) clearInterval(statusTimer);
    };
  }, [phase, projectId]);

  useEffect(() => {
    logBoxRef.current?.scrollTo({ top: logBoxRef.current.scrollHeight });
  }, [log]);

  async function handleStart() {
    if (!sourceUri.trim()) return;
    setStarting(true);
    setFormError(null);
    try {
      const res = await apiFetch(`/projects/${projectId}/database/mongo-import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceUri }),
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(translateApiError(t, body, t.projectDatabase.importMongoStartError));
      }
      if ((body as { alreadyRunning?: boolean }).alreadyRunning) {
        setFormError(t.projectDatabase.importMongoAlreadyRunning);
        setStarting(false);
        return;
      }
      setPhase("importing");
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t.projectDatabase.unknownError);
    } finally {
      setStarting(false);
    }
  }

  const visibleLog = log
    .split("\n")
    .filter((line) => !line.startsWith("__KORRELO_MONGOIMPORT_"))
    .join("\n");

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={() => phase !== "importing" && onClose()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-xl border border-border-subtle bg-surface p-6 shadow-panel"
      >
        {phase === "form" && (
          <>
            <div className="mb-1 flex items-center justify-between gap-3">
              <h2 className="text-[14.5px] font-semibold text-foreground">{t.projectDatabase.importMongoModalTitle}</h2>
              <button onClick={onClose} className="flex-none text-muted-foreground hover:text-foreground">
                <X size={16} />
              </button>
            </div>
            <p className="mb-4 text-[13px] text-muted-foreground">{t.projectDatabase.importMongoModalDescription}</p>

            <label className="mb-1 block text-[12px] text-muted-foreground">{t.projectDatabase.importMongoSourceLabel}</label>
            <textarea
              value={sourceUri}
              onChange={(e) => setSourceUri(e.target.value)}
              placeholder={t.projectDatabase.importMongoSourcePlaceholder}
              rows={2}
              className="w-full resize-none rounded-md border border-border-subtle bg-transparent px-3 py-2 font-mono text-[13px] text-foreground outline-none focus:border-accent"
            />

            <div className="mt-3 flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
              <TriangleAlert size={14} strokeWidth={1.75} className="mt-0.5 flex-none" />
              <span>{t.projectDatabase.importMongoWarning}</span>
            </div>

            {formError && <p className="mt-3 text-[13px] text-destructive">{formError}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <button onClick={onClose} className="rounded-md px-3.5 py-2 text-[13px] font-medium text-muted-foreground hover:bg-muted">
                {t.common.cancel}
              </button>
              <button
                onClick={handleStart}
                disabled={starting || !sourceUri.trim()}
                className="inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-2 text-[13px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {starting && <Loader2 size={14} className="animate-spin" />}
                {t.projectDatabase.importMongoStartButton}
              </button>
            </div>
          </>
        )}

        {phase !== "form" && (
          <>
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
                    ? t.projectDatabase.importMongoFailedTitle
                    : phase === "done"
                      ? t.projectDatabase.importMongoDoneTitle
                      : label || t.projectDatabase.importMongoModalTitle}
                </h2>
              </div>
              {(phase === "failed" || phase === "done") && (
                <button
                  onClick={onClose}
                  aria-label={t.projectDatabase.importMongoCloseButton}
                  className="flex-none text-muted-foreground hover:text-foreground"
                >
                  <X size={16} />
                </button>
              )}
            </div>

            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-all duration-500 ${phase === "failed" ? "bg-destructive" : "bg-accent"}`}
                style={{ width: `${phase === "done" ? 100 : percent}%` }}
              />
            </div>
            <p className="mt-1.5 text-right font-mono text-[12px] text-muted-foreground">
              {phase === "done" ? 100 : percent}%
            </p>

            {phase === "done" && <p className="mt-1 text-[13px] text-muted-foreground">{t.projectDatabase.importMongoDoneSubtitle}</p>}
            {phase === "failed" && errorMessage && <p className="mt-1 text-[13px] text-destructive">{errorMessage}</p>}

            <p className="mb-1.5 mt-4 text-[12px] font-medium text-muted-foreground">{t.projectDatabase.importMongoLogLabel}</p>
            <pre
              ref={logBoxRef}
              className="h-48 overflow-y-auto rounded-lg bg-background p-3 font-mono text-[11.5px] leading-relaxed text-foreground"
            >
              {visibleLog}
            </pre>

            {(phase === "failed" || phase === "done") && (
              <button
                onClick={onClose}
                className="mt-4 w-full rounded-md bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-accent-foreground hover:opacity-90"
              >
                {t.projectDatabase.importMongoCloseButton}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
