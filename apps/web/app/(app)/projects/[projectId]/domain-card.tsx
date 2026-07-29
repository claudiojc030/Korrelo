"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Globe, Loader2 } from "lucide-react";
import type { DomainSslStatus } from "@korrelo/shared-types";
import { apiFetch } from "../../../../lib/api-client";

const STATUS_LABEL: Record<DomainSslStatus, { label: string; className: string }> = {
  none: { label: "-", className: "text-muted-foreground" },
  pending: { label: "Emitindo certificado...", className: "text-warning" },
  active: { label: "HTTPS ativo", className: "text-accent" },
  failed: { label: "Falhou", className: "text-destructive" },
};

export function DomainCard({
  projectId,
  isDeployed,
  customDomain,
  domainSslStatus,
}: {
  projectId: string;
  isDeployed: boolean;
  customDomain: string | null;
  domainSslStatus: DomainSslStatus;
}) {
  const router = useRouter();
  const [domain, setDomain] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAttach(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch(`/projects/${projectId}/domain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "Falha ao anexar domínio.");
      }
      setDomain("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    try {
      await apiFetch(`/projects/${projectId}/domain`, { method: "DELETE" });
      router.refresh();
    } finally {
      setRemoving(false);
    }
  }

  const status = STATUS_LABEL[domainSslStatus];

  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4">
      <h2 className="mb-1 flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
        <Globe size={14} strokeWidth={1.75} />
        Domínio personalizado
      </h2>

      {!isDeployed ? (
        <p className="mt-2 text-[12.5px] text-muted-foreground">Faça o deploy do projeto antes de anexar um domínio.</p>
      ) : customDomain ? (
        <>
          <div className="flex items-center justify-between border-b border-border-subtle py-2.5">
            <span className="text-[13px] text-muted-foreground">Domínio</span>
            <a
              href={`https://${customDomain}`}
              target="_blank"
              rel="noreferrer"
              className="text-[13px] text-accent hover:opacity-85"
            >
              {customDomain}
            </a>
          </div>
          <div className="flex items-center justify-between py-2.5">
            <span className="text-[13px] text-muted-foreground">Status</span>
            <span className={`text-[13px] font-medium ${status.className}`}>{status.label}</span>
          </div>
          <button
            onClick={handleRemove}
            disabled={removing}
            className="mt-2 inline-flex items-center gap-2 text-[13px] font-medium text-destructive hover:opacity-85 disabled:opacity-50"
          >
            {removing && <Loader2 size={14} className="animate-spin" />}
            Remover domínio
          </button>
        </>
      ) : (
        <form onSubmit={handleAttach} className="mt-2 flex flex-col gap-2">
          <p className="text-[12px] text-muted-foreground">
            Aponte o DNS do domínio pro IP desta VPS antes de anexar. O certificado TLS só é emitido se o
            domínio já resolver pra cá.
          </p>
          <div className="flex gap-2">
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="meuapp.com"
              className="min-w-0 flex-1 rounded-md border border-border-subtle bg-transparent px-3 py-2 font-mono text-[13px] text-foreground outline-none focus:border-accent"
            />
            <button
              type="submit"
              disabled={submitting || !domain.trim()}
              className="inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-2 text-[13px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {submitting && <Loader2 size={14} className="animate-spin" />}
              Anexar
            </button>
          </div>
          {error && <p className="text-[12.5px] text-destructive">{error}</p>}
        </form>
      )}
    </div>
  );
}
