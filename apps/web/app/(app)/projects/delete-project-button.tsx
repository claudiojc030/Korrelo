"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2, TriangleAlert, DatabaseBackup, Download, CheckCircle2, XCircle } from "lucide-react";
import { apiFetch, API_URL } from "../../../lib/api-client";
import { useTranslation } from "../../../lib/i18n/locale-provider";
import { translateApiError } from "../../../lib/api-error";

type ExportPhase = "idle" | "exporting" | "done" | "failed";

export function DeleteProjectButton({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasManagedDatabase, setHasManagedDatabase] = useState(false);

  const [exportPhase, setExportPhase] = useState<ExportPhase>("idle");
  const [exportError, setExportError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (!open) return;
    apiFetch(`/projects/${projectId}/database`)
      .then((res) => (res.status === 200 ? res.json() : null))
      .then((db: { type: string } | null) => setHasManagedDatabase(!!db && db.type !== "custom"))
      .catch(() => setHasManagedDatabase(false));
  }, [open, projectId]);

  async function handleExport() {
    setExportPhase("exporting");
    setExportError(null);
    try {
      const res = await apiFetch(`/projects/${projectId}/database/export`, { method: "POST" });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(translateApiError(t, body, t.projects.exportDatabaseStartError));
      }

      const poll = async () => {
        const statusRes = await apiFetch(`/projects/${projectId}/database/export/status`);
        const status: { done: boolean; success: boolean | null; errorMessage?: string } = await statusRes.json();
        if (!status.done) {
          setTimeout(poll, 1000);
          return;
        }
        if (status.success) {
          setExportPhase("done");
        } else {
          setExportError(status.errorMessage ?? t.projects.exportDatabaseStartError);
          setExportPhase("failed");
        }
      };
      poll();
    } catch (err) {
      setExportError(err instanceof Error ? err.message : t.projects.unknownError);
      setExportPhase("failed");
    }
  }

  const canDelete = !hasManagedDatabase || exportPhase === "done" || acknowledged;

  async function handleConfirm() {
    setLoading(true);
    try {
      await apiFetch(`/projects/${projectId}`, { method: "DELETE" });
      setOpen(false);
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label={`${t.projects.remove} ${projectName}`}
        title={t.projects.remove}
        className="inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 size={15} strokeWidth={1.75} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={() => !loading && setOpen(false)}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-md rounded-xl border border-border-subtle bg-surface p-5 shadow-panel"
          >
            <div className="flex items-start gap-3">
              <div className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <TriangleAlert size={16} strokeWidth={1.75} />
              </div>
              <div>
                <p className="text-[14.5px] font-semibold text-foreground">
                  {t.projects.remove} &quot;{projectName}&quot;?
                </p>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  {hasManagedDatabase ? t.projects.deleteConfirmBodyWithDatabase : t.projects.deleteConfirmBody}
                </p>
              </div>
            </div>

            {hasManagedDatabase && (
              <div className="mt-4 rounded-lg border border-border-subtle bg-background p-3">
                {exportPhase === "idle" && (
                  <>
                    <p className="mb-2 text-[12.5px] text-muted-foreground">{t.projects.exportDatabaseDescription}</p>
                    <button
                      onClick={handleExport}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-3 py-1.5 text-[12.5px] font-medium text-foreground hover:bg-muted"
                    >
                      <DatabaseBackup size={13} strokeWidth={1.75} />
                      {t.projects.exportDatabaseButton}
                    </button>
                  </>
                )}
                {exportPhase === "exporting" && (
                  <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                    <Loader2 size={13} className="animate-spin" />
                    {t.projects.exportDatabaseButton}...
                  </p>
                )}
                {exportPhase === "done" && (
                  <p className="flex items-center justify-between gap-2 text-[12.5px] text-accent">
                    <span className="flex items-center gap-1.5">
                      <CheckCircle2 size={13} />
                      {t.projects.exportDatabaseDoneLabel}
                    </span>
                    <a
                      href={`${API_URL}/projects/${projectId}/database/export/download`}
                      className="inline-flex items-center gap-1 font-medium text-accent hover:opacity-85"
                    >
                      <Download size={12} />
                      {t.projects.exportDatabaseDownloadButton}
                    </a>
                  </p>
                )}
                {exportPhase === "failed" && (
                  <p className="flex items-center gap-1.5 text-[12.5px] text-destructive">
                    <XCircle size={13} />
                    {exportError ?? t.projects.exportDatabaseFailedLabel}
                  </p>
                )}

                {exportPhase !== "done" && (
                  <label className="mt-3 flex items-start gap-2 text-[12px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={acknowledged}
                      onChange={(e) => setAcknowledged(e.target.checked)}
                      className="mt-0.5 accent-destructive"
                    />
                    <span>{t.projects.deleteAnywayCheckbox}</span>
                  </label>
                )}
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                disabled={loading}
                className="rounded-md px-3.5 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
              >
                {t.projects.cancel}
              </button>
              <button
                onClick={handleConfirm}
                disabled={loading || !canDelete}
                className="inline-flex items-center gap-2 rounded-md bg-destructive px-3.5 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {loading && <Loader2 size={14} className="animate-spin" />}
                {t.projects.remove}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
