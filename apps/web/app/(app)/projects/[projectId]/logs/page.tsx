"use client";

import { useEffect, useRef, useState, use } from "react";
import { Loader2, RefreshCw, ScrollText, Search } from "lucide-react";
import { apiFetch } from "../../../../../lib/api-client";
import { useTranslation } from "../../../../../lib/i18n/locale-provider";
import { translateApiError } from "../../../../../lib/api-error";

type LogTarget = "app" | "database";

const POLL_MS = 4000;

export default function LogsPage(props: { params: Promise<{ projectId: string }> }) {
  const params = use(props.params);
  const { t } = useTranslation();
  const [target, setTarget] = useState<LogTarget>("app");
  const [hasManagedDatabase, setHasManagedDatabase] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  // Filtro é só de exibição: nunca descarta nada do log de verdade, só
  // esconde da tela as linhas que não batem enquanto o filtro está ativo -
  // limpar a busca mostra tudo de novo.
  const [filter, setFilter] = useState("");
  const scrollRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    apiFetch(`/projects/${params.projectId}/database`)
      .then((res) => (res.status === 200 ? res.json() : null))
      .then((db) => setHasManagedDatabase(!!db && db.type !== "custom"))
      .catch(() => {});
  }, [params.projectId]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await apiFetch(`/projects/${params.projectId}/logs?target=${target}&tail=300`);
        if (!res.ok) {
          const body: unknown = await res.json().catch(() => ({}));
          throw new Error(translateApiError(t, body, t.projectLogs.loadLogsError));
        }
        const data = (await res.json()) as { containerName: string; content: string };
        if (!cancelled) {
          setContent(data.content);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : t.projectLogs.unknownError);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    // Reseta o loading antes de cada busca (troca de aba/projeto ou o
    // próprio polling), pra não mostrar o log antigo como se fosse atual.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [params.projectId, target, t]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [content, autoScroll]);

  const filteredContent = filter.trim()
    ? content
        ?.split("\n")
        .filter((line) => line.toLowerCase().includes(filter.trim().toLowerCase()))
        .join("\n") ?? null
    : content;

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
            {t.projectLogs.appTab}
          </button>
          <button
            onClick={() => setTarget("database")}
            disabled={!hasManagedDatabase}
            className={`rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-40 ${
              target === "database" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.projectLogs.databaseTab}
          </button>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative">
            <Search size={12} strokeWidth={1.75} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t.projectLogs.filterPlaceholder}
              className="w-48 rounded-md border border-border-subtle bg-surface py-1.5 pl-7 pr-2 text-[12.5px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          <label className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="accent-accent"
            />
            {t.projectLogs.autoScroll}
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
          {filteredContent || (filter.trim() ? t.projectLogs.noMatchingLogs : t.projectLogs.noLogsYet)}
        </pre>
      )}

      <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <RefreshCw size={11} />
        {t.projectLogs.refreshEvery.replace("{seconds}", String(POLL_MS / 1000))}
      </div>
    </div>
  );
}
