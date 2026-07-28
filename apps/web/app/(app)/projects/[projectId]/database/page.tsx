"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Database, Eye, EyeOff, Loader2, TriangleAlert } from "lucide-react";
import { apiFetch } from "../../../../../lib/api-client";

type DatabaseType = "postgres" | "redis";

interface ManagedDatabase {
  id: string;
  projectId: string;
  type: DatabaseType;
  username: string;
  password: string;
  databaseName: string;
  createdAt: string;
}

const TYPE_LABEL: Record<DatabaseType, string> = { postgres: "PostgreSQL", redis: "Redis" };
const TYPE_PORT: Record<DatabaseType, number> = { postgres: 5432, redis: 6379 };

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border-subtle py-2.5 last:border-0">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="font-mono text-[13px] text-foreground">{value}</span>
    </div>
  );
}

export default function DatabasePage({ params }: { params: { projectId: string } }) {
  const router = useRouter();
  const [db, setDb] = useState<ManagedDatabase | null | undefined>(undefined);
  const [provisioning, setProvisioning] = useState<DatabaseType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  function load() {
    apiFetch(`/projects/${params.projectId}/database`)
      .then((res) => (res.status === 200 ? res.json() : null))
      .then(setDb)
      .catch(() => setDb(null));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.projectId]);

  async function handleProvision(type: DatabaseType) {
    setProvisioning(type);
    setError(null);
    try {
      const res = await apiFetch(`/projects/${params.projectId}/database`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "Falha ao provisionar o banco.");
      }
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido");
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
        <p className="text-[13px] text-muted-foreground">Carregando...</p>
      </div>
    );
  }

  if (db === null) {
    return (
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <p className="mb-4 text-[13.5px] text-muted-foreground">
          Nenhum banco de dados provisionado pra este projeto ainda.
        </p>
        {error && <p className="mb-3 text-[13px] text-destructive">{error}</p>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(["postgres", "redis"] as DatabaseType[]).map((type) => (
            <div key={type} className="rounded-xl border border-border-subtle bg-surface p-4">
              <div className="flex items-center gap-2 text-foreground">
                <Database size={15} strokeWidth={1.75} />
                <span className="text-[13.5px] font-medium">{TYPE_LABEL[type]}</span>
              </div>
              <p className="mt-1 text-[12px] text-muted-foreground">
                {type === "postgres" ? "Banco relacional, com volume persistente." : "Cache/fila em memória."}
              </p>
              <button
                onClick={() => handleProvision(type)}
                disabled={provisioning !== null}
                className="mt-3 inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-2 text-[13px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {provisioning === type && <Loader2 size={14} className="animate-spin" />}
                Provisionar {TYPE_LABEL[type]}
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const connectionString =
    db.type === "postgres"
      ? `postgresql://${db.username}:${reveal ? db.password : "••••••••"}@db:5432/${db.databaseName}`
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
          {reveal ? "Ocultar senha" : "Mostrar senha"}
        </button>
      </div>

      <div className="rounded-xl border border-border-subtle bg-surface p-4">
        <InfoRow label="Host (dentro da rede do projeto)" value="db" />
        <InfoRow label="Porta" value={TYPE_PORT[db.type]} />
        {db.type === "postgres" && <InfoRow label="Usuário" value={db.username} />}
        {db.type === "postgres" && <InfoRow label="Banco" value={db.databaseName} />}
        <InfoRow label="Senha" value={reveal ? db.password : "••••••••"} />
        <InfoRow label="Connection string" value={<span className="break-all">{connectionString}</span>} />
      </div>

      <p className="mt-3 text-[12.5px] text-muted-foreground">
        Já configurado como variável de ambiente ({db.type === "postgres" ? "DATABASE_URL" : "REDIS_URL"}).
        Rode <span className="font-mono text-foreground">Deploy</span> na aba Resumo pra subir o container do
        banco.
      </p>

      <div className="mt-5">
        <button
          onClick={() => setConfirmRemove(true)}
          className="text-[13px] font-medium text-destructive hover:opacity-85"
        >
          Remover banco de dados
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
                <p className="text-[14.5px] font-semibold text-foreground">Remover o banco de dados?</p>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  Os dados são perdidos no próximo deploy. Não pode ser desfeito.
                </p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirmRemove(false)}
                disabled={removing}
                className="rounded-md px-3.5 py-2 text-[13px] font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleRemove}
                disabled={removing}
                className="inline-flex items-center gap-2 rounded-md bg-destructive px-3.5 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {removing && <Loader2 size={14} className="animate-spin" />}
                Remover
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
