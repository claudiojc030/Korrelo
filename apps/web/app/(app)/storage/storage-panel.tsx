"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { HardDrive, Loader2, ShieldAlert, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import { apiFetch } from "../../../lib/api-client";
import { useTranslation } from "../../../lib/i18n/locale-provider";
import {
  canCleanSafeItems,
  filterStorageItems,
  formatStorageBytes,
  hasRemovableAction,
  storageCategoryKey,
  type StorageCategoryKey,
  type StorageClassification,
} from "../../../lib/storage-view";

type Classification = StorageClassification;
type Category = "docker" | "korrelo" | "system" | "disk";

interface StorageItem {
  id: string;
  category: Category | string;
  label: string;
  bytes: number;
  classification: Classification;
  reason: string;
  proposedAction: string | null;
  command: string | null;
  detail: string | null;
  /** Detalhamento de espaço (cache de build: total/compartilhado/privado/liberável). */
  breakdown?: {
    totalBytes: number;
    sharedBytes: number | null;
    privateBytes: number | null;
    reclaimableBytes: number | null;
    reclaimableSource: string | null;
    divergenceWarning: string | null;
  };
}

interface StorageAction {
  id: string;
  label: string;
  command: string;
  items: StorageItem[];
  bytes: number;
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
  actions: StorageAction[];
  allowedActions: { id: string; label: string; command: string; destructive: boolean; note: string }[];
}

/**
 * ARMAZENAMENTO DA VPS - auditoria (read-only) + limpeza por allowlist.
 *
 * A auditoria NUNCA remove nada: ela mede e classifica. A limpeza só
 * acontece por clique explícito, com confirmação, e só para ações da
 * allowlist que o backend expõe (o frontend nunca envia comando nem path).
 */
export function StoragePanel() {
  const { t } = useTranslation();
  const s = t.storage;
  const [data, setData] = useState<StoragePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [summary, setSummary] = useState<{
    items: number;
    freed: number;
    failures: string[];
    freeBefore: number;
    freeAfter: number;
    diverged: boolean;
    reported: number | null;
  } | null>(null);
  const [classificationFilter, setClassificationFilter] = useState<Classification | "ALL">("ALL");
  const [categoryFilter, setCategoryFilter] = useState<StorageCategoryKey | "ALL">("ALL");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/monitoring/storage", { timeoutMs: 60_000 });
      if (!res.ok) {
        setError(s.loadError);
        return;
      }
      const payload = (await res.json()) as StoragePayload;
      setData(payload);
      setError(null);
    } catch {
      setError(s.loadError);
    } finally {
      setLoading(false);
    }
  }, [s]);

  useEffect(() => {
    // O spinner inicial já está ligado: nada de setState síncrono no effect.
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/monitoring/storage", { timeoutMs: 60_000 });
        if (cancelled) return;
        if (!res.ok) {
          setError(s.loadError);
          return;
        }
        const payload = (await res.json()) as StoragePayload;
        if (cancelled) return;
        setData(payload);
      } catch {
        if (!cancelled) setError(s.loadError);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [s]);

  async function runCleanup() {
    setCleaning(true);
    setError(null);
    try {
      const res = await apiFetch("/monitoring/storage/clean", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actions: data?.actions.map((action) => action.id) ?? [],
        }),
        timeoutMs: 300_000,
      });
      const body = (await res.json().catch(() => ({}))) as {
        bytesFreed?: number;
        results?: { action: string; executed: boolean; error: string | null }[];
        logEntry?: {
          freeBeforeBytes?: number;
          freeAfterBytes?: number;
          bytesFreed?: number;
          reportedBytesFreed?: number | null;
          measurementDiverged?: boolean;
        };
      };
      if (!res.ok) {
        setError(s.cleanFailed);
        return;
      }
      // ANTES x DEPOIS: mesma base (espaço livre do mesmo filesystem),
      // sempre com os valores do log - nunca com números misturados.
      const log = body.logEntry;
      setSummary({
        items: body.results?.filter((item) => item.executed).length ?? 0,
        freed: log?.bytesFreed ?? body.bytesFreed ?? 0,
        failures: (body.results ?? [])
          .filter((item) => item.error)
          .map((item) => `${item.action}: ${item.error}`),
        freeBefore: log?.freeBeforeBytes ?? 0,
        freeAfter: log?.freeAfterBytes ?? 0,
        diverged: log?.measurementDiverged === true,
        reported: log?.reportedBytesFreed ?? null,
      });
      setConfirming(false);
      // Refaz a auditoria automaticamente depois da limpeza.
      await load();
    } catch {
      setError(s.cleanFailed);
    } finally {
      setCleaning(false);
    }
  }

  const items = useMemo(
    () =>
      filterStorageItems(data?.overview.items ?? [], {
        classification: classificationFilter,
        category: categoryFilter,
      }),
    [data, classificationFilter, categoryFilter],
  );

  const safeActions = data?.actions ?? [];
  const hasSafeItems = canCleanSafeItems(safeActions);

  if (loading && !data) {
    return (
      <div className="rounded-xl border border-border-subtle bg-surface p-4">
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          {s.loading}
        </p>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4">
        <p className="text-[13px] text-destructive">{error}</p>
        <button
          onClick={() => {
            setLoading(true);
            void load();
          }}
          className="mt-3 rounded-md border border-border-subtle px-3 py-1.5 text-[12.5px] font-medium text-foreground hover:bg-muted/60"
        >
          {s.analyze}
        </button>
      </div>
    );
  }

  if (!data) return null;
  const { overview } = data;

  const badgeClass: Record<Classification, string> = {
    SAFE_TO_CLEAN: "bg-accent/15 text-accent",
    REVIEW: "bg-warning/15 text-warning",
    KEEP: "bg-muted text-muted-foreground",
    NEVER_TOUCH: "bg-destructive/15 text-destructive",
  };
  const badgeLabel: Record<Classification, string> = {
    SAFE_TO_CLEAN: s.badgeSafe,
    REVIEW: s.badgeReview,
    KEEP: s.badgeKeep,
    NEVER_TOUCH: s.badgeNever,
  };

  return (
    <div>
      {/* AÇÕES */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => {
            setLoading(true);
            setSummary(null);
            void load();
          }}
          disabled={loading || cleaning}
          className="inline-flex items-center gap-2 rounded-md border border-border-subtle px-3 py-1.5 text-[12.5px] font-medium text-foreground hover:bg-muted/60 disabled:opacity-50"
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <HardDrive size={13} />}
          {loading ? s.analyzing : s.analyze}
        </button>
        <button
          onClick={() => setConfirming(true)}
          disabled={!hasSafeItems || cleaning}
          className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-accent-foreground hover:opacity-90 disabled:opacity-40"
        >
          {cleaning ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
          {cleaning ? s.cleaning : s.clean}
        </button>
      </div>

      {error && <p className="mb-3 text-[13px] text-destructive">{error}</p>}

      {confirming && (
        <div className="mb-4 rounded-lg border border-accent/40 bg-accent/10 px-4 py-3">
          <p className="text-[13.5px] font-semibold text-foreground">{s.cleanConfirmTitle}</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">{s.cleanConfirmBody}</p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => void runCleanup()}
              disabled={cleaning}
              className="rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-accent-foreground hover:opacity-90 disabled:opacity-50"
            >
              {s.cleanConfirmYes}
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="rounded-md border border-border-subtle px-3 py-1.5 text-[12.5px] font-medium text-foreground hover:bg-muted/60"
            >
              {s.cleanConfirmNo}
            </button>
          </div>
        </div>
      )}

      {summary && (
        <div className="mb-4 rounded-lg border border-border-subtle bg-surface px-4 py-3">
          <p className="text-[13px] font-semibold text-foreground">{s.cleanSummaryTitle}</p>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-md bg-background px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {s.cleanSummaryItems}
              </p>
              <p className="mt-0.5 font-mono text-[13px] text-foreground">{summary.items}</p>
            </div>
            <div className="rounded-md bg-background px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {s.cleanSummaryFreed}
              </p>
              <p className="mt-0.5 font-mono text-[13px] text-accent">
                {formatStorageBytes(summary.freed)}
              </p>
            </div>
            <div className="rounded-md bg-background px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {s.cleanSummaryFreeBefore}
              </p>
              <p className="mt-0.5 font-mono text-[13px] text-foreground">
                {formatStorageBytes(summary.freeBefore)}
              </p>
            </div>
            <div className="rounded-md bg-background px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {s.cleanSummaryFreeAfter}
              </p>
              <p className="mt-0.5 font-mono text-[13px] text-foreground">
                {formatStorageBytes(summary.freeAfter)}
              </p>
            </div>
          </div>
          {summary.failures.length > 0 && (
            <p className="mt-2 text-[12px] text-destructive">
              {s.cleanSummaryFailures}: {summary.failures.join(" · ")}
            </p>
          )}
          {summary.diverged && (
            <p className="mt-2 text-[12px] text-warning">
              {s.cleanSummaryDivergence}:{" "}
              {s.cleanSummaryDivergenceHint}
              {summary.reported !== null && ` (${formatStorageBytes(summary.reported)})`}
            </p>
          )}
        </div>
      )}

      {/* RESUMO */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {(
          [
            [s.cardUsed, `${formatStorageBytes(overview.usedBytes)} (${overview.usedPercent}%)`, ""],
            [s.cardFree, formatStorageBytes(overview.freeBytes), ""],
            [s.cardSafe, formatStorageBytes(overview.safeToCleanBytes), "text-accent"],
            [s.cardReview, formatStorageBytes(overview.reviewBytes), "text-warning"],
            [s.cardKeep, formatStorageBytes(overview.keepBytes), "text-muted-foreground"],
            [s.cardNever, formatStorageBytes(overview.neverTouchBytes), "text-destructive"],
          ] as [string, string, string][]
        ).map(([label, value, className]) => (
          <div key={label} className="rounded-lg border border-border-subtle bg-surface px-3 py-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className={`mt-0.5 font-mono text-[13px] font-medium ${className}`}>{value}</p>
          </div>
        ))}
      </div>

      {overview.protectionsApplied && (
        <p className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
          <ShieldAlert size={14} className="mt-0.5 flex-none" />
          {s.protectNotice}
        </p>
      )}

      {/* FILTROS */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {(
            [
              ["ALL", s.filterAll],
              ["SAFE_TO_CLEAN", s.filterSafe],
              ["REVIEW", s.filterReview],
              ["KEEP", s.filterKeep],
              ["NEVER_TOUCH", s.filterNever],
            ] as [Classification | "ALL", string][]
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => setClassificationFilter(value)}
              className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                classificationFilter === value
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <select
          value={categoryFilter}
          onChange={(event) => setCategoryFilter(event.target.value as StorageCategoryKey | "ALL")}
          className="rounded-md border border-border-subtle bg-transparent px-2 py-1 text-[12px] text-foreground outline-none"
        >
          <option value="ALL">{s.filterCategoryAll}</option>
          <option value="docker">{s.filterCategoryDocker}</option>
          <option value="buildCache">{s.filterCategoryBuildCache}</option>
          <option value="backups">{s.filterCategoryBackups}</option>
          <option value="selfUpdate">{s.filterCategorySelfUpdate}</option>
          <option value="logs">{s.filterCategoryLogs}</option>
          <option value="caches">{s.filterCategoryCaches}</option>
          <option value="temp">{s.filterCategoryTemp}</option>
          <option value="other">{s.filterCategoryOther}</option>
        </select>
      </div>

      {/* LISTAGEM */}
      <div className="mt-3">
        <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
          {s.itemsTitle}
        </p>
        {items.length === 0 ? (
          <p className="mt-2 rounded-lg border border-border-subtle bg-surface px-3 py-3 text-[12.5px] text-muted-foreground">
            {data.overview.items.length === 0 ? s.noItems : s.itemsEmpty}
          </p>
        ) : (
          <div className="mt-2 overflow-hidden rounded-xl border border-border-subtle bg-surface">
            {/* Cabeçalho (desktop) */}
            <div className="hidden grid-cols-12 gap-3 border-b border-border-subtle px-4 py-2.5 text-[11px] uppercase tracking-wide text-muted-foreground lg:grid">
              <span className="col-span-4">{s.columnName}</span>
              <span className="col-span-2">{s.columnCategory}</span>
              <span className="col-span-1 text-right">{s.columnSize}</span>
              <span className="col-span-2">{s.columnClassification}</span>
              <span className="col-span-3">{s.columnReason}</span>
            </div>
            {items.map((item) => {
              const open = expanded === item.id;
              return (
                <div key={item.id} className="border-b border-border-subtle last:border-0">
                  <button
                    onClick={() => setExpanded(open ? null : item.id)}
                    className="grid w-full grid-cols-1 items-start gap-1 px-4 py-3 text-left lg:grid-cols-12 lg:gap-3"
                  >
                    <span className="col-span-4 flex items-center gap-1.5 text-[13px] font-medium text-foreground">
                      {open ? (
                        <ChevronDown size={13} className="flex-none text-muted-foreground" />
                      ) : (
                        <ChevronRight size={13} className="flex-none text-muted-foreground" />
                      )}
                      <span className="truncate">{item.label}</span>
                    </span>
                    <span className="col-span-2 text-[12.5px] text-muted-foreground">
                      {storageCategoryKey(item)}
                    </span>
                    <span className="col-span-1 text-right font-mono text-[12.5px] text-foreground">
                      {formatStorageBytes(item.bytes)}
                    </span>
                    <span className="col-span-2">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${badgeClass[item.classification]}`}
                      >
                        {badgeLabel[item.classification]}
                      </span>
                    </span>
                    <span className="col-span-3 text-[12.5px] text-muted-foreground">{item.reason}</span>
                  </button>
                  {open && (
                    <div className="space-y-2 border-t border-border-subtle bg-background px-4 py-3">
                      {item.breakdown && (
                        <div>
                          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                            {s.breakdownTitle}
                          </p>
                          <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
                            {(
                              [
                                [s.breakdownTotal, item.breakdown.totalBytes],
                                [s.breakdownShared, item.breakdown.sharedBytes],
                                [s.breakdownPrivate, item.breakdown.privateBytes],
                                [s.breakdownReclaimable, item.breakdown.reclaimableBytes],
                              ] as [string, number | null][]
                            ).map(([label, value]) => (
                              <div key={label} className="rounded-md bg-surface px-2.5 py-1.5">
                                <p className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
                                  {label}
                                </p>
                                <p className="mt-0.5 font-mono text-[12px] text-foreground">
                                  {value === null ? "-" : formatStorageBytes(value)}
                                </p>
                              </div>
                            ))}
                          </div>
                          {item.breakdown.divergenceWarning && (
                            <p className="mt-2 text-[12px] text-warning">
                              {item.breakdown.divergenceWarning}
                            </p>
                          )}
                        </div>
                      )}
                      <div>
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          {s.detailsPath}
                        </p>
                        <p className="font-mono text-[12px] text-foreground">
                          {item.detail ?? "-"}
                        </p>
                      </div>
                      <div>
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          {s.detailsReason}
                        </p>
                        <p className="text-[12.5px] text-foreground">{item.reason}</p>
                      </div>
                      <div>
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          {s.detailsCommand}
                        </p>
                        {item.command ? (
                          <p className="break-words font-mono text-[12px] text-foreground">
                            {item.command}
                          </p>
                        ) : (
                          <p className="text-[12.5px] text-muted-foreground">{s.noAction}</p>
                        )}
                      </div>
                      {item.classification === "NEVER_TOUCH" && (
                        <p className="text-[12px] text-destructive">{s.protectNotice}</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
