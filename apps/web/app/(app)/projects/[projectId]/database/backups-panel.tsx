"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Download, History, Loader2, RotateCcw, TriangleAlert, X, XCircle } from "lucide-react";
import { apiFetch, API_URL } from "../../../../../lib/api-client";
import { useTranslation } from "../../../../../lib/i18n/locale-provider";
import { translateApiError } from "../../../../../lib/api-error";

interface BackupEntry {
  id: string;
  createdAt: string;
  dbType: "postgres" | "mongodb" | "redis";
  fileName: string;
  sizeBytes: number;
}

interface RestoreStatus {
  running: boolean;
  label: string;
  done: boolean;
  success: boolean | null;
  errorMessage?: string;
  log: string;
}

const STATUS_POLL_MS = 1500;

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function BackupsPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [backups, setBackups] = useState<BackupEntry[] | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupEntry | null>(null);

  function load() {
    apiFetch(`/projects/${projectId}/database/backups`)
      .then((res) => (res.ok ? res.json() : []))
      .then(setBackups)
      .catch(() => setBackups([]));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleBackupNow() {
    setBackingUp(true);
    setBackupError(null);
    try {
      const res = await apiFetch(`/projects/${projectId}/database/backups`, { method: "POST" });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(translateApiError(t, body, t.projectDatabase.backupStartError));
      }
      if ((body as { alreadyRunning?: boolean }).alreadyRunning) {
        setBackupError(t.projectDatabase.backupAlreadyRunning);
        setBackingUp(false);
        return;
      }

      const poll = async () => {
        try {
          const statusRes = await apiFetch(`/projects/${projectId}/database/export/status`);
          const status: { done: boolean; success: boolean | null; errorMessage?: string } = await statusRes.json();
          if (!status.done) {
            setTimeout(poll, STATUS_POLL_MS);
            return;
          }
          setBackingUp(false);
          if (status.success) {
            load();
          } else {
            setBackupError(status.errorMessage ?? t.projectDatabase.backupStartError);
          }
        } catch {
          // Timeout/erro no polling: o usuário pode reagir depois; não deixa
          // a requisição abortada virar unhandled rejection.
          setBackingUp(false);
        }
      };
      poll();
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : t.projectDatabase.unknownError);
      setBackingUp(false);
    }
  }

  return (
    <div className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <History size={15} strokeWidth={1.75} className="text-foreground" />
          <h2 className="text-[13.5px] font-semibold text-foreground">{t.projectDatabase.backupsTitle}</h2>
        </div>
        <button
          onClick={handleBackupNow}
          disabled={backingUp}
          className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
        >
          {backingUp && <Loader2 size={13} className="animate-spin" />}
          {backingUp ? t.projectDatabase.backupRunningLabel : t.projectDatabase.backupNowButton}
        </button>
      </div>
      <p className="mb-3 text-[12px] text-muted-foreground">{t.projectDatabase.backupsSubtitle}</p>

      {backupError && <p className="mb-2 text-[12.5px] text-destructive">{backupError}</p>}

      <div className="rounded-xl border border-border-subtle bg-surface">
        {backups === null ? (
          <p className="px-3 py-3 text-[12.5px] text-muted-foreground">{t.common.loading}</p>
        ) : backups.length === 0 ? (
          <p className="px-3 py-3 text-[12.5px] text-muted-foreground">{t.projectDatabase.backupNoneYet}</p>
        ) : (
          backups.map((backup, i) => (
            <div
              key={backup.id}
              className={`flex items-center justify-between gap-3 px-3 py-2.5 ${i > 0 ? "border-t border-border-subtle" : ""}`}
            >
              <div className="min-w-0">
                <p className="text-[12.5px] text-foreground">{new Date(backup.createdAt).toLocaleString()}</p>
                <p className="text-[11.5px] text-muted-foreground">{formatSize(backup.sizeBytes)}</p>
              </div>
              <div className="flex flex-none items-center gap-3">
                <a
                  href={`${API_URL}/projects/${projectId}/database/backups/${backup.id}/download`}
                  className="inline-flex items-center gap-1 text-[12.5px] font-medium text-accent hover:opacity-85"
                >
                  <Download size={13} />
                  {t.projectDatabase.backupDownloadButton}
                </a>
                <button
                  onClick={() => setRestoreTarget(backup)}
                  className="inline-flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground hover:text-foreground"
                >
                  <RotateCcw size={13} />
                  {t.projectDatabase.backupRestoreButton}
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {restoreTarget && (
        <RestoreModal
          projectId={projectId}
          backup={restoreTarget}
          onClose={() => setRestoreTarget(null)}
        />
      )}
    </div>
  );
}

type RestorePhase = "confirm" | "restoring" | "done" | "failed";

function RestoreModal({
  projectId,
  backup,
  onClose,
}: {
  projectId: string;
  backup: BackupEntry;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<RestorePhase>("confirm");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState("");
  const logBoxRef = useRef<HTMLPreElement>(null);
  const phaseRef = useRef<RestorePhase>("confirm");

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    if (phase !== "restoring") return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    async function poll() {
      try {
        const res = await apiFetch(`/projects/${projectId}/database/restore/status`);
        if (!res.ok || cancelled) return;
        const status: RestoreStatus = await res.json();
        if (cancelled) return;
        setLog(status.log);
        if (status.done && phaseRef.current === "restoring") {
          if (timer) clearInterval(timer);
          setPhase(status.success ? "done" : "failed");
          if (!status.success) setError(status.errorMessage ?? null);
        }
      } catch {
        // tenta de novo no próximo tick
      }
    }

    timer = setInterval(poll, STATUS_POLL_MS);
    poll();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [phase, projectId]);

  useEffect(() => {
    logBoxRef.current?.scrollTo({ top: logBoxRef.current.scrollHeight });
  }, [log]);

  async function handleConfirm() {
    setStarting(true);
    setError(null);
    try {
      const res = await apiFetch(`/projects/${projectId}/database/backups/${backup.id}/restore`, { method: "POST" });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(translateApiError(t, body, t.projectDatabase.restoreStartError));
      }
      setPhase("restoring");
    } catch (err) {
      setError(err instanceof Error ? err.message : t.projectDatabase.unknownError);
    } finally {
      setStarting(false);
    }
  }

  const visibleLog = log.split("\n").filter((line) => !line.startsWith("__KORRELO_DBRESTORE_")).join("\n");

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={() => phase !== "restoring" && onClose()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-border-subtle bg-surface p-5 shadow-panel"
      >
        {phase === "confirm" && (
          <>
            <div className="flex items-start gap-3">
              <div className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <TriangleAlert size={16} strokeWidth={1.75} />
              </div>
              <div>
                <p className="text-[14.5px] font-semibold text-foreground">{t.projectDatabase.restoreConfirmTitle}</p>
                <p className="mt-1 text-[13px] text-muted-foreground">{t.projectDatabase.restoreConfirmBody}</p>
                <p className="mt-2 font-mono text-[12px] text-muted-foreground">
                  {new Date(backup.createdAt).toLocaleString()}
                </p>
              </div>
            </div>
            {error && <p className="mt-3 text-[13px] text-destructive">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={onClose}
                disabled={starting}
                className="rounded-md px-3.5 py-2 text-[13px] font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                {t.common.cancel}
              </button>
              <button
                onClick={handleConfirm}
                disabled={starting}
                className="inline-flex items-center gap-2 rounded-md bg-destructive px-3.5 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {starting && <Loader2 size={14} className="animate-spin" />}
                {t.projectDatabase.restoreConfirmButton}
              </button>
            </div>
          </>
        )}

        {phase !== "confirm" && (
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
                    ? t.projectDatabase.restoreFailedTitle
                    : phase === "done"
                      ? t.projectDatabase.restoreDoneTitle
                      : t.projectDatabase.restoreRunningTitle}
                </h2>
              </div>
              {(phase === "failed" || phase === "done") && (
                <button onClick={onClose} className="flex-none text-muted-foreground hover:text-foreground">
                  <X size={16} />
                </button>
              )}
            </div>

            {phase === "failed" && error && <p className="mb-2 text-[13px] text-destructive">{error}</p>}

            <p className="mb-1.5 text-[12px] font-medium text-muted-foreground">{t.projectDatabase.restoreLogLabel}</p>
            <pre
              ref={logBoxRef}
              className="h-40 overflow-y-auto rounded-lg bg-background p-3 font-mono text-[11.5px] leading-relaxed text-foreground"
            >
              {visibleLog}
            </pre>

            {(phase === "failed" || phase === "done") && (
              <button
                onClick={onClose}
                className="mt-4 w-full rounded-md bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-accent-foreground hover:opacity-90"
              >
                {t.projectDatabase.restoreCloseButton}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
