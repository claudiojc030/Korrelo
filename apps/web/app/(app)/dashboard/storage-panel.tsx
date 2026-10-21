"use client";

import { useCallback, useEffect, useState } from "react";
import { HardDrive, Loader2, ShieldAlert, Trash2 } from "lucide-react";
import { apiFetch } from "../../../lib/api-client";
import { useTranslation } from "../../../lib/i18n/locale-provider";

type Classification = "SAFE_TO_CLEAN" | "REVIEW" | "KEEP" | "NEVER_TOUCH";

interface StorageItem {
  id: string;
  category: string;
  label: string;
  bytes: number;
  classification: Classification;
  reason: string;
  proposedAction: string | null;
  command: string | null;
  detail: string | null;
}

interface StorageAction {
  id: string;
  label: string;
  command: string;
  destructive: boolean;
  note: string;
}

interface StoragePayload {
  overview: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usedPercent: number;
    safeToCleanBytes: number;
    reviewBytes: number;
    keepBytes: number;
    neverTouchBytes: number;
    items: StorageItem[];
    categories: { category: string; bytes: number; items: number }[];
    protectionsApplied: boolean;
    note: string;
  };
  actions: { id: string; label: string; command: string; items: StorageItem[]; bytes: number }[];
  allowedActions: StorageAction[];
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const CLASSIFICATION_STYLE: Record<Classification, string> = {
  SAFE_TO_CLEAN: "text-accent",
  REVIEW: "text-warning",
  KEEP: "text-muted-foreground",
  NEVER_TOUCH: "text-destructive",
};

/**
 * ARMAZENAMENTO DO SERVIDOR (read-only + limpeza por allowlist).
 *
 * A auditoria NUNCA remove nada: ela mede e classifica. A limpeza só
 * acontece por clique explícito, e só para ações da allowlist que o
 * backend expoe (o frontend nunca envia comando nem path).
 */
export function StoragePanel() {
  const { t } = useTranslation();
  const [data, setData] = useState<StoragePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [cleaning, setCleaning] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  // Recarrega a auditoria (usado pelo botão "Atualizar").
  const reload = useCallback(async () => {
    try {
      const res = await apiFetch("/monitoring/storage", { timeoutMs: 60_000 });
      if (!res.ok) {
        setError(t.dashboard.storageLoadError);
        return;
      }
      const payload = (await res.json()) as StoragePayload;
      setData(payload);
      setError(null);
    } catch {
      setError(t.dashboard.storageLoadError);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    // O spinner inicial já está ligado (loading = true). O fetch é feito
    // aqui dentro (mesmo padrão do modal do self-update) para não haver
    // setState síncrono dentro do effect.
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/monitoring/storage", { timeoutMs: 60_000 });
        if (cancelled) return;
        if (!res.ok) {
          setError(t.dashboard.storageLoadError);
          return;
        }
        const payload = (await res.json()) as StoragePayload;
        if (cancelled) return;
        setData(payload);
      } catch {
        if (!cancelled) setError(t.dashboard.storageLoadError);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  async function runCleanup() {
    if (selected.length === 0) return;
    setCleaning(true);
    setResult(null);
    try {
      const res = await apiFetch("/monitoring/storage/clean", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actions: selected, operator: "painel" }),
        timeoutMs: 300_000,
      });
      const body = (await res.json()) as {
        bytesFreed?: number;
        logEntry?: { failures?: string[] };
      };
      if (!res.ok) {
        setError(t.dashboard.storageCleanError);
        return;
      }
      setResult(
        t.dashboard.storageCleanDone.replace("{{bytes}}", formatBytes(body.bytesFreed ?? 0)),
      );
      setSelected([]);
      await reload();
    } catch {
      setError(t.dashboard.storageCleanError);
    } finally {
      setCleaning(false);
    }
  }

  if (loading && !data) {
    return (
      <div className="rounded-xl border border-border-subtle bg-surface p-4">
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          {t.dashboard.storageLoading}
        </p>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4">
        <p className="text-[13px] text-destructive">{error}</p>
      </div>
    );
  }

  if (!data) return null;
  const { overview } = data;

  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <HardDrive size={15} strokeWidth={1.75} className="text-muted-foreground" />
          <p className="text-[13.5px] font-medium text-foreground">{t.dashboard.title}</p>
        </div>
        <button
          onClick={() => {
            setLoading(true);
            void reload();
          }}
          disabled={loading}
          className="text-[12px] font-medium text-accent hover:opacity-85 disabled:opacity-50"
        >
          {t.dashboard.storageRefresh}
        </button>
      </div>

      {/* VISÃO GERAL */}
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-4">
        <div className="rounded-lg bg-background px-3 py-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {t.dashboard.storageTotal}
          </p>
          <p className="mt-0.5 font-mono text-[14px] font-medium text-foreground">
            {formatBytes(overview.totalBytes)}
          </p>
        </div>
        <div className="rounded-lg bg-background px-3 py-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {t.dashboard.storageUsed}
          </p>
          <p className="mt-0.5 font-mono text-[14px] font-medium text-foreground">
            {formatBytes(overview.usedBytes)} ({overview.usedPercent}%)
          </p>
        </div>
        <div className="rounded-lg bg-background px-3 py-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {t.dashboard.storageFree}
          </p>
          <p className="mt-0.5 font-mono text-[14px] font-medium text-foreground">
            {formatBytes(overview.freeBytes)}
          </p>
        </div>
        <div className="rounded-lg bg-background px-3 py-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {t.dashboard.storageSafeToClean}
          </p>
          <p className="mt-0.5 font-mono text-[14px] font-medium text-accent">
            {formatBytes(overview.safeToCleanBytes)}
          </p>
        </div>
      </div>

      {/* TOTAIS POR CLASSIFICAÇÃO */}
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-4">
        {(
          [
            ["SAFE_TO_CLEAN", overview.safeToCleanBytes, t.dashboard.storageClassSafe],
            ["REVIEW", overview.reviewBytes, t.dashboard.storageClassReview],
            ["KEEP", overview.keepBytes, t.dashboard.storageClassKeep],
            ["NEVER_TOUCH", overview.neverTouchBytes, t.dashboard.storageClassNever],
          ] as [Classification, number, string][]
        ).map(([classification, bytes, label]) => (
          <div key={classification} className="rounded-lg bg-background px-3 py-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className={`mt-0.5 font-mono text-[13px] font-medium ${CLASSIFICATION_STYLE[classification]}`}>
              {formatBytes(bytes)}
            </p>
          </div>
        ))}
      </div>

      {overview.protectionsApplied && (
        <p className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
          <ShieldAlert size={14} className="mt-0.5 flex-none" />
          {t.dashboard.storageProtectionNotice}
        </p>
      )}

        {/* ACOES DE LIMPEZA (allowlist do backend) */}
      {data.actions.length > 0 && (
        <div className="mt-4">
          <p className="text-[12px] font-medium text-muted-foreground">
            {t.dashboard.storageActionsTitle}
          </p>
          <div className="mt-2 space-y-2">
            {data.actions.map((action) => {
              const definition = data.allowedActions.find((item) => item.id === action.id);
              const checked = selected.includes(action.id);
              return (
                <label
                  key={action.id}
                  className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border-subtle bg-background px-3 py-2"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={checked}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, action.id]
                          : current.filter((id) => id !== action.id),
                      )
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium text-foreground">{action.label}</p>
                    <p className="mt-0.5 text-[12px] text-muted-foreground">
                      {formatBytes(action.bytes)} · {action.items.length} item(ns)
                    </p>
                    {definition?.note && (
                      <p className="mt-0.5 text-[11.5px] text-muted-foreground">{definition.note}</p>
                    )}
                    <code className="mt-1 block overflow-x-auto text-[11px] text-muted-foreground/80">
                      {action.command}
                    </code>
                  </div>
                </label>
              );
            })}
          </div>
          <button
            onClick={runCleanup}
            disabled={cleaning || selected.length === 0}
            className="mt-3 inline-flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-accent-foreground hover:opacity-90 disabled:opacity-50"
          >
            {cleaning ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
            {t.dashboard.storageCleanButton}
          </button>
          {result && <p className="mt-2 text-[12.5px] text-accent">{result}</p>}
          {error && <p className="mt-2 text-[12.5px] text-destructive">{error}</p>}
        </div>
      )}

      {/* ITENS */}
      <div className="mt-4">
        <p className="text-[12px] font-medium text-muted-foreground">{t.dashboard.storageItemsTitle}</p>
        <div className="mt-2 space-y-1.5">
          {overview.items.map((item) => (
            <div
              key={item.id}
              className="rounded-lg border border-border-subtle bg-background px-3 py-2"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 text-[12.5px] font-medium text-foreground">{item.label}</p>
                <p className="flex-none font-mono text-[12px] text-muted-foreground">
                  {formatBytes(item.bytes)}
                </p>
              </div>
              <p className="mt-0.5 text-[11.5px] text-muted-foreground">{item.reason}</p>
              <p className={`mt-0.5 text-[11px] font-semibold ${CLASSIFICATION_STYLE[item.classification]}`}>
                {item.classification}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
