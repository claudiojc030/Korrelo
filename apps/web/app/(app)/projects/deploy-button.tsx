"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Rocket, Loader2 } from "lucide-react";
import { apiFetch } from "../../../lib/api-client";

export function DeployButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDeploy() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/projects/${projectId}/deploy`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json()) as { message?: string };
        throw new Error(body.message ?? "Falha ao fazer deploy.");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido");
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
        {loading ? "Fazendo deploy..." : "Deploy"}
      </button>
      {error && <p className="text-[12px] text-destructive">{error}</p>}
    </div>
  );
}
