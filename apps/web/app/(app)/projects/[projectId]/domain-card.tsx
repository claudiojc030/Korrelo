"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Globe, Loader2 } from "lucide-react";
import type { DomainSslStatus } from "@korrelo/shared-types";
import { apiFetch } from "../../../../lib/api-client";
import { useTranslation } from "../../../../lib/i18n/locale-provider";
import { translateApiError } from "../../../../lib/api-error";

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
  const { t } = useTranslation();
  const STATUS_LABEL: Record<DomainSslStatus, { label: string; className: string }> = {
    none: { label: t.projectDetail.domainStatusNone, className: "text-muted-foreground" },
    pending: { label: t.projectDetail.domainStatusPending, className: "text-warning" },
    active: { label: t.projectDetail.domainStatusActive, className: "text-accent" },
    failed: { label: t.projectDetail.domainStatusFailed, className: "text-destructive" },
  };
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
        const body: unknown = await res.json().catch(() => ({}));
        throw new Error(translateApiError(t, body, t.projectDetail.attachFailedError));
      }
      setDomain("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.projectDetail.unknownError);
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
        {t.projectDetail.customDomainTitle}
      </h2>

      {!isDeployed ? (
        <p className="mt-2 text-[12.5px] text-muted-foreground">{t.projectDetail.deployBeforeDomain}</p>
      ) : customDomain ? (
        <>
          <div className="flex items-center justify-between border-b border-border-subtle py-2.5">
            <span className="text-[13px] text-muted-foreground">{t.projectDetail.domainLabel}</span>
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
            <span className="text-[13px] text-muted-foreground">{t.projectDetail.statusLabel}</span>
            <span className={`text-[13px] font-medium ${status.className}`}>{status.label}</span>
          </div>
          <button
            onClick={handleRemove}
            disabled={removing}
            className="mt-2 inline-flex items-center gap-2 text-[13px] font-medium text-destructive hover:opacity-85 disabled:opacity-50"
          >
            {removing && <Loader2 size={14} className="animate-spin" />}
            {t.projectDetail.removeDomain}
          </button>
        </>
      ) : (
        <form onSubmit={handleAttach} className="mt-2 flex flex-col gap-2">
          <p className="text-[12px] text-muted-foreground">
            {t.projectDetail.dnsInstructions}
          </p>
          <div className="flex gap-2">
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder={t.projectDetail.domainPlaceholder}
              className="min-w-0 flex-1 rounded-md border border-border-subtle bg-transparent px-3 py-2 font-mono text-[13px] text-foreground outline-none focus:border-accent"
            />
            <button
              type="submit"
              disabled={submitting || !domain.trim()}
              className="inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-2 text-[13px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {submitting && <Loader2 size={14} className="animate-spin" />}
              {t.projectDetail.attachDomain}
            </button>
          </div>
          {error && <p className="text-[12.5px] text-destructive">{error}</p>}
        </form>
      )}
    </div>
  );
}
