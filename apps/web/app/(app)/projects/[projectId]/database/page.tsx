"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import { Database, DatabaseZap, Eye, EyeOff, Loader2, Play, TriangleAlert } from "lucide-react";
import { apiFetch } from "../../../../../lib/api-client";
import { useTranslation } from "../../../../../lib/i18n/locale-provider";
import { translateApiError } from "../../../../../lib/api-error";
import type { ProjectDatabaseDict } from "../../../../../lib/i18n/dictionaries/project-database";

type DatabaseType = "postgres" | "redis" | "mongodb" | "custom";

interface ManagedDatabase {
  id: string;
  projectId: string;
  type: DatabaseType;
  username: string | null;
  password: string | null;
  databaseName: string | null;
  connectionString: string | null;
  envVarKey: string | null;
  persistent: boolean;
  createdAt: string;
}

function getTypeLabels(t: ProjectDatabaseDict): Record<DatabaseType, string> {
  return {
    postgres: t.typeLabelPostgres,
    redis: t.typeLabelRedis,
    mongodb: t.typeLabelMongodb,
    custom: t.typeLabelCustom,
  };
}
const TYPE_PORT: Record<"postgres" | "redis" | "mongodb", number> = {
  postgres: 5432,
  redis: 6379,
  mongodb: 27017,
};

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border-subtle py-2.5 last:border-0">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="font-mono text-[13px] text-foreground">{value}</span>
    </div>
  );
}

export default function DatabasePage(props: { params: Promise<{ projectId: string }> }) {
  const params = use(props.params);
  const router = useRouter();
  const { t } = useTranslation();
  const TYPE_LABEL = getTypeLabels(t.projectDatabase);
  const [db, setDb] = useState<ManagedDatabase | null | undefined>(undefined);
  const [databaseEnabled, setDatabaseEnabled] = useState(true);
  const [provisioning, setProvisioning] = useState<DatabaseType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customEnvVarKey, setCustomEnvVarKey] = useState("DATABASE_URL");
  const [customConnectionString, setCustomConnectionString] = useState("");
  const [redisPersistent, setRedisPersistent] = useState(false);

  function load() {
    apiFetch(`/projects/${params.projectId}/database`)
      .then((res) => (res.status === 200 ? res.json() : null))
      .then(setDb)
      .catch(() => setDb(null));
    apiFetch(`/projects/${params.projectId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((p) => setDatabaseEnabled(p ? p.databaseEnabled : true))
      .catch(() => {});
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.projectId]);

  async function handleProvision(type: DatabaseType, body: Record<string, unknown> = {}) {
    setProvisioning(type);
    setError(null);
    try {
      const res = await apiFetch(`/projects/${params.projectId}/database`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, ...body }),
      });
      if (!res.ok) {
        const resBody: unknown = await res.json().catch(() => ({}));
        throw new Error(translateApiError(t, resBody, t.projectDatabase.provisionError));
      }
      setCustomOpen(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.projectDatabase.unknownError);
    } finally {
      setProvisioning(null);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    try {
      await apiFetch(`/projects/${params.projectId}/database`, { method: "DELETE" });
      setConfirmRemove(false);
      load();
      router.refresh();
    } finally {
      setRemoving(false);
    }
  }

  if (db === undefined) {
    return (
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <p className="text-[13px] text-muted-foreground">{t.common.loading}</p>
      </div>
    );
  }

  if (!databaseEnabled) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center gap-2 px-8 py-6 text-center">
        <Database size={20} strokeWidth={1.75} className="text-muted-foreground" />
        <p className="text-[13.5px] font-medium text-foreground">{t.projectDatabase.disabledTitle}</p>
        <p className="text-[12.5px] text-muted-foreground">{t.projectDatabase.disabledSubtitle}</p>
      </div>
    );
  }

  if (db === null) {
    return (
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <p className="mb-4 text-[13.5px] text-muted-foreground">{t.projectDatabase.emptyState}</p>
        {error && <p className="mb-3 text-[13px] text-destructive">{error}</p>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {(["postgres", "redis", "mongodb"] as DatabaseType[]).map((type) => (
            <div key={type} className="rounded-xl border border-border-subtle bg-surface p-4">
              <div className="flex items-center gap-2 text-foreground">
                <Database size={15} strokeWidth={1.75} />
                <span className="text-[13.5px] font-medium">{TYPE_LABEL[type]}</span>
              </div>
              <p className="mt-1 text-[12px] text-muted-foreground">
                {type === "postgres" && t.projectDatabase.postgresDescription}
                {type === "redis" && t.projectDatabase.redisDescription}
                {type === "mongodb" && t.projectDatabase.mongodbDescription}
              </p>

              {type === "redis" && (
                <label className="mt-2.5 flex items-start gap-2 text-[12px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={redisPersistent}
                    onChange={(e) => setRedisPersistent(e.target.checked)}
                    className="mt-0.5 accent-accent"
                  />
                  <span>{t.projectDatabase.redisPersistentLabel}</span>
                </label>
              )}

              <button
                onClick={() => handleProvision(type, type === "redis" ? { persistRedis: redisPersistent } : {})}
                disabled={provisioning !== null}
                className="mt-3 inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-2 text-[13px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {provisioning === type && <Loader2 size={14} className="animate-spin" />}
                {t.projectDatabase.provisionButtonTemplate.replace("{type}", TYPE_LABEL[type])}
              </button>
            </div>
          ))}

          <div className="rounded-xl border border-border-subtle bg-surface p-4 sm:col-span-3">
            <div className="flex items-center gap-2 text-foreground">
              <DatabaseZap size={15} strokeWidth={1.75} />
              <span className="text-[13.5px] font-medium">{TYPE_LABEL.custom}</span>
            </div>
            <p className="mt-1 text-[12px] text-muted-foreground">{t.projectDatabase.customDescription}</p>

            {!customOpen ? (
              <button
                onClick={() => setCustomOpen(true)}
                className="mt-3 rounded-md border border-border-subtle px-3.5 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
              >
                {t.projectDatabase.connectExternalButton}
              </button>
            ) : (
              <div className="mt-3 flex flex-col gap-3">
                <div>
                  <label className="mb-1 block text-[12px] text-muted-foreground">
                    {t.projectDatabase.envVarNameLabel}
                  </label>
                  <input
                    value={customEnvVarKey}
                    onChange={(e) => setCustomEnvVarKey(e.target.value)}
                    placeholder={t.projectDatabase.envVarNamePlaceholder}
                    className="w-full rounded-md border border-border-subtle bg-transparent px-3 py-2 font-mono text-[13px] text-foreground outline-none focus:border-accent"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[12px] text-muted-foreground">
                    {t.projectDatabase.connectionStringLabel}
                  </label>
                  <textarea
                    value={customConnectionString}
                    onChange={(e) => setCustomConnectionString(e.target.value)}
                    placeholder={t.projectDatabase.connectionStringPlaceholder}
                    rows={2}
                    className="w-full resize-none rounded-md border border-border-subtle bg-transparent px-3 py-2 font-mono text-[13px] text-foreground outline-none focus:border-accent"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() =>
                      handleProvision("custom", {
                        envVarKey: customEnvVarKey,
                        connectionString: customConnectionString,
                      })
                    }
                    disabled={provisioning !== null || !customConnectionString.trim()}
                    className="inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-2 text-[13px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
                  >
                    {provisioning === "custom" && <Loader2 size={14} className="animate-spin" />}
                    {t.projectDatabase.connectButton}
                  </button>
                  <button
                    onClick={() => setCustomOpen(false)}
                    className="rounded-md px-3.5 py-2 text-[13px] font-medium text-muted-foreground hover:bg-muted"
                  >
                    {t.common.cancel}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const isCustom = db.type === "custom";
  const connectionString = isCustom
    ? (reveal ? db.connectionString : "••••••••") ?? ""
    : db.type === "postgres"
      ? `postgresql://${db.username}:${reveal ? db.password : "••••••••"}@db:5432/${db.databaseName}`
      : db.type === "mongodb"
        ? `mongodb://${db.username}:${reveal ? db.password : "••••••••"}@db:27017/${db.databaseName}?authSource=admin`
        : `redis://:${reveal ? db.password : "••••••••"}@db:6379`;

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-6">
      <div className="mb-4 flex items-center justify-between">
        <p className="flex items-center gap-2 text-[13.5px] font-medium text-foreground">
          <Database size={15} strokeWidth={1.75} />
          {TYPE_LABEL[db.type]}
        </p>
        <button
          onClick={() => setReveal((v) => !v)}
          className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground"
        >
          {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
          {reveal ? t.projectDatabase.hidePassword : t.projectDatabase.showPassword}
        </button>
      </div>

      <div className="rounded-xl border border-border-subtle bg-surface p-4">
        {isCustom ? (
          <>
            <InfoRow label={t.projectDatabase.envVarLabel} value={db.envVarKey} />
            <InfoRow label={t.projectDatabase.connectionStringLabel} value={<span className="break-all">{connectionString}</span>} />
          </>
        ) : (
          <>
            <InfoRow label={t.projectDatabase.hostLabel} value="db" />
            <InfoRow label={t.projectDatabase.portLabel} value={TYPE_PORT[db.type as "postgres" | "redis" | "mongodb"]} />
            {db.type !== "redis" && <InfoRow label={t.projectDatabase.usernameLabel} value={db.username} />}
            {db.type !== "redis" && <InfoRow label={t.projectDatabase.databaseNameLabel} value={db.databaseName} />}
            <InfoRow label={t.projectDatabase.passwordLabel} value={reveal ? db.password : "••••••••"} />
            <InfoRow label={t.projectDatabase.connectionStringLabel} value={<span className="break-all">{connectionString}</span>} />
            {db.type === "redis" && (
              <InfoRow
                label={t.projectDatabase.persistenceLabel}
                value={
                  db.persistent ? (
                    <span className="text-accent">{t.projectDatabase.persistenceEnabled}</span>
                  ) : (
                    <span className="text-muted-foreground">{t.projectDatabase.persistenceDisabled}</span>
                  )
                }
              />
            )}
          </>
        )}
      </div>

      <p className="mt-3 text-[12.5px] text-muted-foreground">
        {isCustom ? (
          <>
            {t.projectDatabase.externalInfoPrefix}{" "}
            <span className="font-mono text-foreground">{db.envVarKey}</span> {t.projectDatabase.externalInfoSuffix}
          </>
        ) : (
          <>
            {t.projectDatabase.configuredInfoPrefix}
            {db.type === "postgres" ? "DATABASE_URL" : db.type === "mongodb" ? "MONGODB_URI" : "REDIS_URL"}
            {t.projectDatabase.configuredInfoMiddle}{" "}
            <span className="font-mono text-foreground">Deploy</span> {t.projectDatabase.configuredInfoSuffix}
          </>
        )}
      </p>

      {!isCustom && (
        <DatabaseBrowser projectId={params.projectId} type={db.type as "postgres" | "redis" | "mongodb"} />
      )}

      <div className="mt-5">
        <button
          onClick={() => setConfirmRemove(true)}
          className="text-[13px] font-medium text-destructive hover:opacity-85"
        >
          {t.projectDatabase.removeDatabaseButton}
        </button>
      </div>

      {confirmRemove && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={() => !removing && setConfirmRemove(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-xl border border-border-subtle bg-surface p-5 shadow-panel"
          >
            <div className="flex items-start gap-3">
              <div className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <TriangleAlert size={16} strokeWidth={1.75} />
              </div>
              <div>
                <p className="text-[14.5px] font-semibold text-foreground">{t.projectDatabase.confirmRemoveTitle}</p>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  {isCustom
                    ? t.projectDatabase.confirmRemoveCustomBody
                    : t.projectDatabase.confirmRemoveBody}
                </p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirmRemove(false)}
                disabled={removing}
                className="rounded-md px-3.5 py-2 text-[13px] font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                {t.common.cancel}
              </button>
              <button
                onClick={handleRemove}
                disabled={removing}
                className="inline-flex items-center gap-2 rounded-md bg-destructive px-3.5 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {removing && <Loader2 size={14} className="animate-spin" />}
                {t.projectDatabase.remove}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface QueryResult {
  columns: string[];
  rows: string[][];
  rowCount: number;
  notice: string | null;
}

function DatabaseBrowser({ projectId, type }: { projectId: string; type: "postgres" | "redis" | "mongodb" }) {
  const { t } = useTranslation();
  const QUERY_PLACEHOLDER: Record<"postgres" | "redis" | "mongodb", string> = {
    postgres: t.projectDatabase.postgresQueryPlaceholder,
    mongodb: t.projectDatabase.mongodbQueryPlaceholder,
    redis: "KEYS *",
  };
  const [tables, setTables] = useState<string[] | null>(null);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);

  function loadTables() {
    setTablesError(null);
    apiFetch(`/projects/${projectId}/database/tables`)
      .then(async (res) => {
        if (!res.ok) {
          const body: unknown = await res.json().catch(() => ({}));
          throw new Error(translateApiError(t, body, t.projectDatabase.listTablesError));
        }
        return res.json();
      })
      .then((data: { tables: string[] }) => setTables(data.tables))
      .catch((err) => setTablesError(err instanceof Error ? err.message : t.projectDatabase.unknownError));
  }

  useEffect(() => {
    loadTables();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleRunQuery() {
    if (!query.trim()) return;
    setRunning(true);
    setQueryError(null);
    setResult(null);
    try {
      const res = await apiFetch(`/projects/${projectId}/database/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(translateApiError(t, body, t.projectDatabase.queryError));
      }
      setResult(body as QueryResult);
    } catch (err) {
      setQueryError(err instanceof Error ? err.message : t.projectDatabase.unknownError);
    } finally {
      setRunning(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      handleRunQuery();
    }
  }

  const entityLabel =
    type === "mongodb"
      ? t.projectDatabase.entityLabelCollections
      : type === "redis"
        ? t.projectDatabase.entityLabelKeysSample
        : t.projectDatabase.entityLabelTables;

  return (
    <div className="mt-6">
      <div className="mb-2 flex items-center gap-2">
        <Database size={15} strokeWidth={1.75} className="text-foreground" />
        <h2 className="text-[13.5px] font-semibold text-foreground">{t.projectDatabase.browserTitle}</h2>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[220px_1fr]">
        <div className="rounded-xl border border-border-subtle bg-surface p-3">
          <p className="mb-2 px-1 text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
            {entityLabel}
          </p>
          {tablesError ? (
            <p className="px-1 text-[12px] text-destructive">{tablesError}</p>
          ) : tables === null ? (
            <p className="px-1 text-[12px] text-muted-foreground">{t.common.loading}</p>
          ) : tables.length === 0 ? (
            <p className="px-1 text-[12px] text-muted-foreground">{t.projectDatabase.noneFoundYet}</p>
          ) : (
            <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
              {tables.map((name) => (
                <li key={name}>
                  <button
                    onClick={() => {
                      if (type === "postgres") setQuery(`SELECT * FROM "${name}" LIMIT 100;`);
                      else if (type === "mongodb") setQuery(`db.${name}.find().limit(20).toArray()`);
                      else setQuery(`GET ${name}`);
                    }}
                    className="w-full truncate rounded-md px-2 py-1.5 text-left font-mono text-[12.5px] text-foreground hover:bg-muted"
                    title={name}
                  >
                    {name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={QUERY_PLACEHOLDER[type]}
            rows={3}
            spellCheck={false}
            className="w-full resize-none rounded-md border border-border-subtle bg-transparent px-3 py-2 font-mono text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-accent"
          />
          <div className="flex items-center justify-between">
            <p className="text-[11.5px] text-muted-foreground">{t.projectDatabase.ctrlEnterHint}</p>
            <button
              onClick={handleRunQuery}
              disabled={running || !query.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-1.5 text-[13px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              {t.projectDatabase.runButton}
            </button>
          </div>

          {queryError && <p className="text-[13px] text-destructive">{queryError}</p>}

          {result && (
            <div className="rounded-xl border border-border-subtle bg-surface">
              {result.notice && (
                <p className="border-b border-border-subtle px-3 py-2 text-[12.5px] text-muted-foreground">
                  {result.notice}
                </p>
              )}
              {result.columns.length > 0 ? (
                <div className="max-h-96 overflow-auto">
                  <table className="w-full border-collapse text-left text-[12.5px]">
                    <thead>
                      <tr>
                        {result.columns.map((col) => (
                          <th
                            key={col}
                            className="sticky top-0 border-b border-border-subtle bg-surface px-3 py-2 font-medium text-muted-foreground"
                          >
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.map((row, i) => (
                        <tr key={i} className="border-b border-border-subtle last:border-0">
                          {row.map((cell, j) => (
                            <td key={j} className="whitespace-pre-wrap px-3 py-1.5 font-mono text-foreground">
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                !result.notice && (
                  <p className="px-3 py-2 text-[12.5px] text-muted-foreground">{t.projectDatabase.noResult}</p>
                )
              )}
              <p className="border-t border-border-subtle px-3 py-1.5 text-[11.5px] text-muted-foreground">
                {t.projectDatabase.rowCountTemplate.replace("{count}", String(result.rowCount))}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
