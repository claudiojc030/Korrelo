"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import { Database, DatabaseZap, Eye, EyeOff, Loader2, Pencil, Play, Save, Trash2, TriangleAlert, X } from "lucide-react";
import { apiFetch } from "../../../../../lib/api-client";
import { useTranslation } from "../../../../../lib/i18n/locale-provider";
import { translateApiError } from "../../../../../lib/api-error";
import type { ProjectDatabaseDict } from "../../../../../lib/i18n/dictionaries/project-database";
import { MongoImportModal } from "./mongo-import-modal";
import { BackupsPanel } from "./backups-panel";
import { DeployButton } from "../../deploy-button";

type DatabaseType = "postgres" | "redis" | "mongodb" | "custom";

interface ManagedDatabase {
  id: string;
  projectId: string;
  type: DatabaseType;
  serviceName: string | null;
  username: string | null;
  password: string | null;
  databaseName: string | null;
  connectionString: string | null;
  envVarKey: string | null;
  persistent: boolean;
  createdAt: string;
}

function pickPrimary(databases: ManagedDatabase[]): ManagedDatabase | undefined {
  return [...databases].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
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
  const [databases, setDatabases] = useState<ManagedDatabase[] | undefined>(undefined);
  const [databaseEnabled, setDatabaseEnabled] = useState(true);
  const [provisioning, setProvisioning] = useState<DatabaseType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<DatabaseType | null>(null);
  const [removing, setRemoving] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customEnvVarKey, setCustomEnvVarKey] = useState("DATABASE_URL");
  const [customConnectionString, setCustomConnectionString] = useState("");
  const [redisPersistent, setRedisPersistent] = useState(false);
  const [importMongoOpen, setImportMongoOpen] = useState(false);
  const [importVersion, setImportVersion] = useState(0);
  const [dbContainerNotRunning, setDbContainerNotRunning] = useState(false);

  function load() {
    apiFetch(`/projects/${params.projectId}/database`)
      .then((res) => (res.status === 200 ? res.json() : []))
      .then(setDatabases)
      .catch(() => setDatabases([]));
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
    if (!confirmRemove) return;
    setRemoving(true);
    try {
      await apiFetch(`/projects/${params.projectId}/database?type=${confirmRemove}`, { method: "DELETE" });
      setConfirmRemove(null);
      load();
      router.refresh();
    } finally {
      setRemoving(false);
    }
  }

  if (databases === undefined) {
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

  const nonCustom = databases.filter((d) => d.type !== "custom");
  const primary = pickPrimary(nonCustom);
  const provisionedTypes = new Set(databases.map((d) => d.type));
  const availableTypes = (["postgres", "redis", "mongodb"] as DatabaseType[]).filter((type) => !provisionedTypes.has(type));
  const removeTarget = databases.find((d) => d.type === confirmRemove);

  if (databases.length === 0) {
    return (
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <p className="mb-4 text-[13.5px] text-muted-foreground">{t.projectDatabase.emptyState}</p>
        {error && <p className="mb-3 text-[13px] text-destructive">{error}</p>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {availableTypes.map((type) => (
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

  const hasMongo = provisionedTypes.has("mongodb");

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-6">
      {error && <p className="mb-3 text-[13px] text-destructive">{error}</p>}

      <div className="flex flex-col gap-3">
        {databases.map((entry) => (
          <DatabaseCard
            key={entry.id}
            db={entry}
            typeLabel={TYPE_LABEL[entry.type]}
            reveal={reveal}
            onToggleReveal={() => setReveal((v) => !v)}
            onRemove={() => setConfirmRemove(entry.type)}
          />
        ))}
      </div>

      {availableTypes.length > 0 && (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {availableTypes.map((type) => (
            <div key={type} className="rounded-xl border border-dashed border-border-subtle bg-surface p-4">
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

          {!provisionedTypes.has("custom") && (
            <div className="rounded-xl border border-dashed border-border-subtle bg-surface p-4 sm:col-span-3">
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
          )}
        </div>
      )}

      {primary && (
        <DatabaseBrowser
          key={importVersion}
          projectId={params.projectId}
          type={primary.type as "postgres" | "redis" | "mongodb"}
          onContainerStatusChange={setDbContainerNotRunning}
        />
      )}

      {primary && <BackupsPanel projectId={params.projectId} />}

      {hasMongo && (
        <div className="mt-5 flex items-center gap-4">
          <button
            onClick={() => setImportMongoOpen(true)}
            disabled={dbContainerNotRunning}
            title={dbContainerNotRunning ? t.projectDatabase.importMongoDisabledHint : undefined}
            className="rounded-md border border-border-subtle px-3.5 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
          >
            {t.projectDatabase.importMongoButton}
          </button>
        </div>
      )}

      {importMongoOpen && (
        <MongoImportModal
          projectId={params.projectId}
          onClose={() => setImportMongoOpen(false)}
          onImported={() => setImportVersion((v) => v + 1)}
        />
      )}

      {confirmRemove && removeTarget && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={() => !removing && setConfirmRemove(null)}
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
                  {removeTarget.type === "custom"
                    ? t.projectDatabase.confirmRemoveCustomBody
                    : t.projectDatabase.confirmRemoveBody}
                </p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirmRemove(null)}
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

function DatabaseCard({
  db,
  typeLabel,
  reveal,
  onToggleReveal,
  onRemove,
}: {
  db: ManagedDatabase;
  typeLabel: string;
  reveal: boolean;
  onToggleReveal: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const isCustom = db.type === "custom";
  const host = db.serviceName ?? "db";
  const connectionString = isCustom
    ? (reveal ? db.connectionString : "••••••••") ?? ""
    : db.type === "postgres"
      ? `postgresql://${db.username}:${reveal ? db.password : "••••••••"}@${host}:5432/${db.databaseName}`
      : db.type === "mongodb"
        ? `mongodb://${db.username}:${reveal ? db.password : "••••••••"}@${host}:27017/${db.databaseName}?authSource=admin`
        : `redis://:${reveal ? db.password : "••••••••"}@${host}:6379`;

  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="flex items-center gap-2 text-[13.5px] font-medium text-foreground">
          <Database size={15} strokeWidth={1.75} />
          {typeLabel}
        </p>
        <div className="flex items-center gap-3">
          <button
            onClick={onToggleReveal}
            className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground"
          >
            {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
            {reveal ? t.projectDatabase.hidePassword : t.projectDatabase.showPassword}
          </button>
          <button onClick={onRemove} className="text-[12.5px] font-medium text-destructive hover:opacity-85">
            {t.projectDatabase.removeDatabaseButton}
          </button>
        </div>
      </div>

      {isCustom ? (
        <>
          <InfoRow label={t.projectDatabase.envVarLabel} value={db.envVarKey} />
          <InfoRow label={t.projectDatabase.connectionStringLabel} value={<span className="break-all">{connectionString}</span>} />
        </>
      ) : (
        <>
          <InfoRow label={t.projectDatabase.hostLabel} value={host} />
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
    </div>
  );
}

interface QueryResult {
  columns: string[];
  rows: string[][];
  rowCount: number;
  notice: string | null;
}

// O backend já converte valores não-string com JSON.stringify (pra caber numa
// célula de texto). Sem desfazer isso aqui, número/objeto/array reaparecia
// entre aspas na visualização em JSON, parecendo string por engano.
function parseMongoCell(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function DatabaseBrowser({
  projectId,
  type,
  onContainerStatusChange,
}: {
  projectId: string;
  type: "postgres" | "redis" | "mongodb";
  onContainerStatusChange?: (notRunning: boolean) => void;
}) {
  const { t } = useTranslation();
  const QUERY_PLACEHOLDER: Record<"postgres" | "redis" | "mongodb", string> = {
    postgres: t.projectDatabase.postgresQueryPlaceholder,
    mongodb: t.projectDatabase.mongodbQueryPlaceholder,
    redis: "KEYS *",
  };
  const [tables, setTables] = useState<string[] | null>(null);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [containerNotRunning, setContainerNotRunning] = useState(false);
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  // Null quando o texto da query não veio de clicar numa tabela/coleção na
  // lista (ex.: usuário digitou algo manualmente) - sem isso não dá pra saber
  // com segurança em qual tabela gravar as edições.
  const [sourceTable, setSourceTable] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [primaryKeyColumns, setPrimaryKeyColumns] = useState<string[] | null>(null);
  const [pkLoading, setPkLoading] = useState(false);
  const [edits, setEdits] = useState<Record<number, Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDeleteRow, setConfirmDeleteRow] = useState<number | null>(null);
  const [deletingRow, setDeletingRow] = useState(false);

  function loadTables() {
    setTablesError(null);
    setContainerNotRunning(false);
    apiFetch(`/projects/${projectId}/database/tables`)
      .then(async (res) => {
        if (!res.ok) {
          const body: unknown = await res.json().catch(() => ({}));
          const isContainerNotRunning = Boolean(
            body && typeof body === "object" && (body as { code?: unknown }).code === "DATABASE_CONTAINER_NOT_RUNNING",
          );
          setContainerNotRunning(isContainerNotRunning);
          onContainerStatusChange?.(isContainerNotRunning);
          throw new Error(translateApiError(t, body, t.projectDatabase.listTablesError));
        }
        onContainerStatusChange?.(false);
        return res.json();
      })
      .then((data: { tables: string[] }) => setTables(data.tables))
      .catch((err) => setTablesError(err instanceof Error ? err.message : t.projectDatabase.unknownError));
  }

  useEffect(() => {
    // loadTables seta loading/error de forma síncrona antes do fetch assíncrono.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadTables();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleRunQuery(queryOverride?: string, tableOverride?: string | null) {
    const queryToRun = queryOverride ?? query;
    if (!queryToRun.trim()) return;
    setRunning(true);
    setQueryError(null);
    setResult(null);
    setEditMode(false);
    setEdits({});
    setPrimaryKeyColumns(null);
    setSaveError(null);
    if (tableOverride !== undefined) setSourceTable(tableOverride);
    try {
      const res = await apiFetch(`/projects/${projectId}/database/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: queryToRun }),
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

  function selectEntity(name: string) {
    const q =
      type === "postgres"
        ? `SELECT * FROM "${name}" LIMIT 100;`
        : type === "mongodb"
          ? `db.${name}.find().limit(20).toArray()`
          : `GET ${name}`;
    setQuery(q);
    // Mongo e Postgres têm dados "prontos pra ver" ao clicar (igual o Atlas);
    // Redis não, porque "name" ali é uma chave de amostra, não um comando -
    // GET só faz sentido se o usuário confirmar que é isso que quer rodar.
    if (type !== "redis") handleRunQuery(q, name);
  }

  async function toggleEditMode() {
    if (editMode) {
      setEditMode(false);
      setEdits({});
      return;
    }
    if (!sourceTable) return;
    setPkLoading(true);
    setSaveError(null);
    try {
      const res = await apiFetch(`/projects/${projectId}/database/tables/${encodeURIComponent(sourceTable)}/primary-key`);
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(translateApiError(t, body, t.projectDatabase.queryError));
      const columns = (body as { columns: string[] }).columns;
      if (columns.length === 0) {
        setSaveError(t.projectDatabase.editNoPrimaryKey);
        return;
      }
      setPrimaryKeyColumns(columns);
      setEditMode(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t.projectDatabase.unknownError);
    } finally {
      setPkLoading(false);
    }
  }

  function setCellEdit(rowIndex: number, column: string, value: string) {
    setEdits((prev) => ({ ...prev, [rowIndex]: { ...prev[rowIndex], [column]: value } }));
  }

  function cellValue(rowIndex: number, column: string, original: string): string {
    return edits[rowIndex]?.[column] ?? original;
  }

  async function handleSaveEdits() {
    if (!result || !sourceTable || !primaryKeyColumns) return;
    const rowIndexes = Object.keys(edits).map(Number).filter((i) => Object.keys(edits[i]).length > 0);
    if (rowIndexes.length === 0) return;

    setSaving(true);
    setSaveError(null);
    try {
      const updates = rowIndexes.map((rowIndex) => {
        const primaryKey: Record<string, string> = {};
        for (const pkCol of primaryKeyColumns) {
          const colIndex = result.columns.indexOf(pkCol);
          primaryKey[pkCol] = colIndex >= 0 ? result.rows[rowIndex][colIndex] : "";
        }
        return { primaryKey, changes: edits[rowIndex] };
      });

      const res = await apiFetch(`/projects/${projectId}/database/rows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table: sourceTable, updates }),
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(translateApiError(t, body, t.projectDatabase.editSaveError));

      const results = (body as { results: { error: string | null }[] }).results;
      const firstError = results.find((r) => r.error)?.error;
      if (firstError) {
        setSaveError(firstError);
        return;
      }

      setEditMode(false);
      setEdits({});
      await handleRunQuery(query, sourceTable);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t.projectDatabase.unknownError);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteRow() {
    if (confirmDeleteRow === null || !result || !sourceTable || !primaryKeyColumns) return;
    const rowIndex = confirmDeleteRow;
    const primaryKey: Record<string, string> = {};
    for (const pkCol of primaryKeyColumns) {
      const colIndex = result.columns.indexOf(pkCol);
      primaryKey[pkCol] = colIndex >= 0 ? result.rows[rowIndex][colIndex] : "";
    }

    setDeletingRow(true);
    setSaveError(null);
    try {
      const res = await apiFetch(`/projects/${projectId}/database/rows`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table: sourceTable, primaryKeys: [primaryKey] }),
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(translateApiError(t, body, t.projectDatabase.editSaveError));

      const results = (body as { results: { error: string | null }[] }).results;
      const firstError = results.find((r) => r.error)?.error;
      if (firstError) {
        setSaveError(firstError);
        return;
      }

      setConfirmDeleteRow(null);
      setEdits((prev) => {
        const next = { ...prev };
        delete next[rowIndex];
        return next;
      });
      await handleRunQuery(query, sourceTable);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t.projectDatabase.unknownError);
    } finally {
      setDeletingRow(false);
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
            <div className="px-1">
              <p className="text-[12px] text-destructive">{tablesError}</p>
              {containerNotRunning && (
                <div className="mt-2">
                  <DeployButton projectId={projectId} onDeployed={loadTables} />
                </div>
              )}
            </div>
          ) : tables === null ? (
            <p className="px-1 text-[12px] text-muted-foreground">{t.common.loading}</p>
          ) : tables.length === 0 ? (
            <p className="px-1 text-[12px] text-muted-foreground">{t.projectDatabase.noneFoundYet}</p>
          ) : (
            <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
              {tables.map((name) => (
                <li key={name}>
                  <button
                    onClick={() => selectEntity(name)}
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
            onChange={(e) => {
              setQuery(e.target.value);
              setSourceTable(null);
              setEditMode(false);
              setEdits({});
            }}
            onKeyDown={handleKeyDown}
            placeholder={QUERY_PLACEHOLDER[type]}
            rows={3}
            spellCheck={false}
            className="w-full resize-none rounded-md border border-border-subtle bg-transparent px-3 py-2 font-mono text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-accent"
          />
          <div className="flex items-center justify-between">
            <p className="text-[11.5px] text-muted-foreground">{t.projectDatabase.ctrlEnterHint}</p>
            <button
              onClick={() => handleRunQuery()}
              disabled={running || !query.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-1.5 text-[13px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              {t.projectDatabase.runButton}
            </button>
          </div>

          {queryError && <p className="text-[13px] text-destructive">{queryError}</p>}

          {result && result.columns.length > 0 && sourceTable && type !== "redis" && (
            <div className="flex items-center justify-between">
              <div>
                {saveError && <p className="text-[12.5px] text-destructive">{saveError}</p>}
              </div>
              <div className="flex items-center gap-2">
                {editMode && (
                  <button
                    onClick={handleSaveEdits}
                    disabled={saving || Object.keys(edits).length === 0}
                    className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
                  >
                    {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                    {t.projectDatabase.editSaveButton}
                  </button>
                )}
                <button
                  onClick={toggleEditMode}
                  disabled={pkLoading}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
                >
                  {pkLoading ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : editMode ? (
                    <X size={13} />
                  ) : (
                    <Pencil size={13} />
                  )}
                  {editMode ? t.projectDatabase.editCancelButton : t.projectDatabase.editEnableButton}
                </button>
              </div>
            </div>
          )}

          {result && (
            <div className="rounded-xl border border-border-subtle bg-surface">
              {result.notice && (
                <p className="border-b border-border-subtle px-3 py-2 text-[12.5px] text-muted-foreground">
                  {result.notice}
                </p>
              )}
              {result.columns.length > 0 && type === "mongodb" && !editMode ? (
                <div className="flex max-h-96 flex-col gap-2 overflow-auto p-3">
                  {result.rows.map((row, i) => (
                    <pre
                      key={i}
                      className="whitespace-pre-wrap break-words rounded-md border border-border-subtle bg-background px-3 py-2 font-mono text-[12px] text-foreground"
                    >
                      {JSON.stringify(
                        Object.fromEntries(result.columns.map((col, j) => [col, parseMongoCell(row[j])])),
                        null,
                        2,
                      )}
                    </pre>
                  ))}
                </div>
              ) : result.columns.length > 0 && type === "mongodb" ? (
                <div className="flex max-h-96 flex-col gap-3 overflow-auto p-3">
                  {result.rows.map((row, i) => (
                    <div key={i} className="rounded-md border border-border-subtle bg-background p-2">
                      <div className="mb-1 flex justify-end">
                        <button
                          onClick={() => setConfirmDeleteRow(i)}
                          title={t.projectDatabase.deleteRowButton}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                      {result.columns.map((col, j) => (
                        <div key={col} className="flex items-center gap-2 py-0.5">
                          <span className="w-32 flex-none truncate font-mono text-[11.5px] text-muted-foreground" title={col}>
                            {col}
                          </span>
                          <input
                            value={cellValue(i, col, row[j])}
                            onChange={(e) => setCellEdit(i, col, e.target.value)}
                            disabled={primaryKeyColumns?.includes(col)}
                            className="w-full rounded border border-border-subtle bg-transparent px-2 py-1 font-mono text-[12px] text-foreground outline-none focus:border-accent disabled:opacity-60"
                          />
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ) : result.columns.length > 0 ? (
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
                        {editMode && <th className="sticky top-0 border-b border-border-subtle bg-surface px-2 py-2" />}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.map((row, i) => (
                        <tr key={i} className="border-b border-border-subtle last:border-0">
                          {row.map((cell, j) =>
                            editMode ? (
                              <td key={j} className="px-1.5 py-1">
                                <input
                                  value={cellValue(i, result.columns[j], cell)}
                                  onChange={(e) => setCellEdit(i, result.columns[j], e.target.value)}
                                  disabled={primaryKeyColumns?.includes(result.columns[j])}
                                  className="w-full min-w-[80px] rounded border border-border-subtle bg-transparent px-1.5 py-1 font-mono text-[12.5px] text-foreground outline-none focus:border-accent disabled:opacity-60"
                                />
                              </td>
                            ) : (
                              <td key={j} className="whitespace-pre-wrap px-3 py-1.5 font-mono text-foreground">
                                {cell}
                              </td>
                            ),
                          )}
                          {editMode && (
                            <td className="px-1.5 py-1 text-right">
                              <button
                                onClick={() => setConfirmDeleteRow(i)}
                                title={t.projectDatabase.deleteRowButton}
                                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                              >
                                <Trash2 size={13} />
                              </button>
                            </td>
                          )}
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

      {confirmDeleteRow !== null && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={() => !deletingRow && setConfirmDeleteRow(null)}
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
                <p className="text-[14.5px] font-semibold text-foreground">{t.projectDatabase.deleteRowConfirmTitle}</p>
                <p className="mt-1 text-[13px] text-muted-foreground">{t.projectDatabase.deleteRowConfirmBody}</p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirmDeleteRow(null)}
                disabled={deletingRow}
                className="rounded-md px-3.5 py-2 text-[13px] font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                {t.common.cancel}
              </button>
              <button
                onClick={handleDeleteRow}
                disabled={deletingRow}
                className="inline-flex items-center gap-2 rounded-md bg-destructive px-3.5 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {deletingRow && <Loader2 size={14} className="animate-spin" />}
                {t.projectDatabase.deleteRowConfirmButton}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
