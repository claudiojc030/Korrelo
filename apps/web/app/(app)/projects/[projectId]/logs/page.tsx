"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, ScrollText } from "lucide-react";
import { apiFetch } from "../../../../../lib/api-client";

type LogTarget = "app" | "database";

const POLL_MS = 4000;

export default function LogsPage({ params }: { params: { projectId: string } }) {
  const [target, setTarget] = useState<LogTarget>("app");
  const [hasManagedDatabase, setHasManagedDatabase] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    apiFetch(`/projects/${params.projectId}/database`)
      .then((res) => (res.status === 200 ? res.json() : null))
      .then((db) => setHasManagedDatabase(!!db && db.type !== "custom"))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.projectId]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await apiFetch(`/projects/${params.projectId}/logs?target=${target}&tail=300`);
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          throw new Error(body.message ?? "Falha ao carregar logs.");
        }
        const data = (await res.json()) as { containerName: string; content: string };
        if (!cancelled) {
          setContent(data.content);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Erro desconhecido");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    setLoading(true);
    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [params.projectId, target]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [content, autoScroll]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-8 py-6">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-1 rounded-lg border border-border-subtle p-0.5">
          <button
            onClick={() => setTarget("app")}
            className={`rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
              target === "app" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            App
          </button>
          <button
            onClick={() => setTarget("database")}
            disabled={!hasManagedDatabase}
            className={`rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-40 ${
              target === "database" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Banco de Dados
          </button>
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="accent-accent"
            />
            Auto-scroll
          </label>
          {loading && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
        </div>
      </div>

      {error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <ScrollText size={20} strokeWidth={1.75} className="text-muted-foreground" />
          <p className="text-[13px] text-destructive">{error}</p>
        </div>
      ) : (
        <pre
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-border-subtle bg-surface p-4 font-mono text-[12px] leading-relaxed text-foreground"
        >
          {content || "Sem logs ainda."}
        </pre>
      )}

      <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <RefreshCw size={11} />
        Atualiza a cada {POLL_MS / 1000}s
      </div>
    </div>
  );
}
