"use client";

import { useEffect, useState } from "react";
import { Loader2, ShieldHalf } from "lucide-react";
import { apiFetch } from "../../../lib/api-client";
import { useTranslation } from "../../../lib/i18n/locale-provider";
import { translateApiError } from "../../../lib/api-error";
import type { SystemServicesDict } from "../../../lib/i18n/dictionaries/system-services";

interface SystemService {
  id: string;
  displayName: string;
  category: string;
  description: string;
  riskLevel: "baixo" | "medio" | "alto";
  riskNote: string;
  exists: boolean;
  active: boolean;
  enabled: boolean;
}

function riskStyle(t: SystemServicesDict): Record<SystemService["riskLevel"], { label: string; className: string }> {
  return {
    baixo: { label: t.riskLow, className: "bg-accent/10 text-accent" },
    medio: { label: t.riskMedium, className: "bg-warning/10 text-warning" },
    alto: { label: t.riskHigh, className: "bg-destructive/10 text-destructive" },
  };
}

function ServiceRow({
  service,
  pending,
  onToggle,
  t,
}: {
  service: SystemService;
  pending: boolean;
  onToggle: (enabled: boolean) => void;
  t: SystemServicesDict;
}) {
  const risk = riskStyle(t)[service.riskLevel];
  const isOn = service.exists && (service.active || service.enabled);

  return (
    <div className="flex items-start justify-between gap-4 border-b border-border-subtle py-4 last:border-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[13.5px] font-medium text-foreground">{service.displayName}</p>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${risk.className}`}>{risk.label}</span>
          {!service.exists && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {t.notPresent}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">{service.description}</p>
        <p className="mt-1 text-[12px] text-muted-foreground/80">
          <span className="font-medium">{t.disableEffectLabel}</span> {service.riskNote}
        </p>
      </div>

      <button
        role="switch"
        aria-checked={isOn}
        disabled={!service.exists || pending}
        onClick={() => onToggle(!isOn)}
        className={`relative h-6 w-11 flex-none rounded-full transition-colors disabled:opacity-30 ${
          isOn ? "bg-accent" : "bg-muted"
        }`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
            isOn ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}

export default function SystemServicesPage() {
  const { t } = useTranslation();
  const systemServices = t.systemServices;
  const [services, setServices] = useState<SystemService[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  function load() {
    apiFetch("/system-services")
      .then((res) => (res.ok ? res.json() : null))
      .then(setServices)
      .catch(() => setServices([]));
  }

  useEffect(() => {
    load();
  }, []);

  async function handleToggle(id: string, enabled: boolean) {
    setPendingId(id);
    setError(null);
    try {
      const res = await apiFetch(`/system-services/${id}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        throw new Error(translateApiError(t, body, systemServices.errorToggleFailed));
      }
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : systemServices.errorUnknown);
    } finally {
      setPendingId(null);
    }
  }

  if (services === null) {
    return (
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <p className="text-[13px] text-muted-foreground">{systemServices.loading}</p>
      </div>
    );
  }

  const byCategory = services.reduce<Record<string, SystemService[]>>((acc, service) => {
    (acc[service.category] ??= []).push(service);
    return acc;
  }, {});

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-6">
      <div className="mb-1 flex items-center gap-2">
        <ShieldHalf size={16} strokeWidth={1.75} className="text-foreground" />
        <h1 className="text-[15px] font-semibold text-foreground">{systemServices.pageTitle}</h1>
      </div>
      <p className="mb-5 text-[12.5px] text-muted-foreground">{systemServices.pageDescription}</p>

      {error && <p className="mb-3 text-[13px] text-destructive">{error}</p>}

      {Object.entries(byCategory).map(([category, items]) => (
        <div key={category} className="mb-4 rounded-xl border border-border-subtle bg-surface px-4">
          <p className="pt-3.5 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{category}</p>
          {items.map((service) => (
            <ServiceRow
              key={service.id}
              service={service}
              pending={pendingId === service.id}
              onToggle={(enabled) => handleToggle(service.id, enabled)}
              t={systemServices}
            />
          ))}
        </div>
      ))}

      {pendingId && (
        <p className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <Loader2 size={13} className="animate-spin" />
          {systemServices.applying}
        </p>
      )}
    </div>
  );
}
