"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { apiFetch } from "../../../../lib/api-client";
import { useTranslation } from "../../../../lib/i18n/locale-provider";
import { reconcileProjectState } from "../../../../lib/project-reconcile";

/**
 * Controle de RECONCILIAÇÃO para projetos em estado INDETERMINADO.
 *
 * Chama SOMENTE POST /projects/:id/reconcile. Não executa deploy, rollback
 * nem restart: o backend valida container/imagem/readiness antes de liberar.
 */
export function ReconcileStateControl({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function handleClick(): Promise<void> {
    if (running) return;
    if (!window.confirm(t.projectDetail.reconcileConfirm)) return;
    setRunning(true);
    setMessage(null);
    try {
      const result = await reconcileProjectState(apiFetch, projectId);
      if (result.ok) {
        setMessage({ kind: "ok", text: t.projectDetail.reconcileSuccess });
        router.refresh();
      } else if (result.status === 409) {
        setMessage({
          kind: "error",
          text: result.message
            ? `${t.projectDetail.reconcileBlocked} ${result.message}`
            : t.projectDetail.reconcileBlocked,
        });
      } else {
        setMessage({
          kind: "error",
          text: result.message ?? t.projectDetail.reconcileFailed,
        });
      }
    } catch {
      setMessage({ kind: "error", text: t.projectDetail.reconcileFailed });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mb-4 rounded-xl border border-destructive/40 bg-surface p-4">
      <p className="text-[13.5px] font-medium text-foreground">{t.projectDetail.reconcileTitle}</p>
      <p className="mt-1 text-[12.5px] text-muted-foreground">{t.projectDetail.reconcileDescription}</p>
      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={handleClick}
          disabled={running}
          className="inline-flex items-center gap-2 rounded-md border border-border-subtle px-3 py-1.5 text-[12.5px] font-medium text-foreground hover:bg-muted disabled:opacity-50"
        >
          {running && <Loader2 size={14} className="animate-spin" />}
          {running ? t.projectDetail.reconcileRunning : t.projectDetail.reconcileButton}
        </button>
        {message && (
          <p
            role="status"
            className={`text-[12.5px] ${
              message.kind === "ok" ? "text-foreground" : "text-destructive"
            }`}
          >
            {message.text}
          </p>
        )}
      </div>
    </div>
  );
}
