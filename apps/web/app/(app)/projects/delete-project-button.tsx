"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2, TriangleAlert } from "lucide-react";
import { apiFetch } from "../../../lib/api-client";
import { useTranslation } from "../../../lib/i18n/locale-provider";

export function DeleteProjectButton({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

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
            className="w-full max-w-sm rounded-xl border border-border-subtle bg-surface p-5 shadow-panel"
          >
            <div className="flex items-start gap-3">
              <div className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <TriangleAlert size={16} strokeWidth={1.75} />
              </div>
              <div>
                <p className="text-[14.5px] font-semibold text-foreground">
                  {t.projects.remove} &quot;{projectName}&quot;?
                </p>
                <p className="mt-1 text-[13px] text-muted-foreground">{t.projects.deleteConfirmBody}</p>
              </div>
            </div>

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
                disabled={loading}
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
