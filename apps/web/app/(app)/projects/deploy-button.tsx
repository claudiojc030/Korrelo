"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Rocket, Loader2 } from "lucide-react";
import { apiFetch } from "../../../lib/api-client";
import { useTranslation } from "../../../lib/i18n/locale-provider";
import { translateApiError } from "../../../lib/api-error";

export function DeployButton({ projectId, onDeployed }: { projectId: string; onDeployed?: () => void }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleDeploy() {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch(`/projects/${projectId}/deploy`, { method: "POST" });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        throw new Error(translateApiError(t, body, t.projects.deployError));
      }
      // 202 nao significa "concluido": mostra se o pedido criou job novo, se
      // ja havia um na fila ou se o worker esta em manutencao (deferred).
      const body = (await res.json().catch(() => null)) as
        | { created?: boolean; deferred?: boolean }
        | null;
      setNotice(
        body?.deferred
          ? t.projectDetail.deployDeferred
          : body?.created === false
            ? t.projectDetail.deployAlreadyQueued
            : null,
      );
      router.refresh();
      onDeployed?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.projects.unknownError);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={handleDeploy}
        disabled={loading}
        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-accent hover:opacity-85 disabled:opacity-50"
      >
        {loading ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} strokeWidth={1.75} />}
        {loading ? t.projects.deploying : t.projects.deployAction}
      </button>
      {notice && <p className="text-[12px] text-muted-foreground">{notice}</p>}
      {error && <p className="text-[12px] text-destructive">{error}</p>}
    </div>
  );
}
