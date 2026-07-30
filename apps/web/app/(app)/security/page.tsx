"use client";

import { useEffect, useState } from "react";
import { KeyRound, Laptop, Loader2, LogOut, ShieldCheck, ShieldOff, Smartphone, TriangleAlert } from "lucide-react";
import { apiFetch } from "../../../lib/api-client";
import { useTranslation } from "../../../lib/i18n/locale-provider";
import { translateApiError } from "../../../lib/api-error";
import type { SecurityDict } from "../../../lib/i18n/dictionaries/security";

type Step = "loading" | "disabled" | "setting-up" | "showing-backup-codes" | "enabled";

interface ActiveSession {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

function describeUserAgent(userAgent: string | null, t: SecurityDict): { label: string; isMobile: boolean } {
  if (!userAgent) return { label: t.unknownDevice, isMobile: false };
  const isMobile = /Mobi|Android|iPhone|iPad/.test(userAgent);
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Chrome\//.test(userAgent)
      ? "Chrome"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : t.browserGeneric;
  const os = /iPhone|iPad/.test(userAgent)
    ? "iOS"
    : /Windows/.test(userAgent)
      ? "Windows"
      : /Mac OS/.test(userAgent)
        ? "macOS"
        : /Android/.test(userAgent)
          ? "Android"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "";
  return { label: os ? `${browser} · ${os}` : browser, isMobile };
}

function formatRelativeTime(iso: string, t: SecurityDict): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 1) return t.justNow;
  if (diffMin < 60) return t.minAgoTemplate.replace("{n}", String(diffMin));
  const diffHours = Math.round(diffMin / 60);
  if (diffHours < 24) return t.hourAgoTemplate.replace("{n}", String(diffHours));
  const diffDays = Math.round(diffHours / 24);
  return t.dayAgoTemplate.replace("{n}", String(diffDays));
}

export default function SecurityPage() {
  const { t } = useTranslation();
  const security = t.security;
  const [step, setStep] = useState<Step>("loading");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [secret, setSecret] = useState("");
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState("");
  const [confirmCode, setConfirmCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);

  const [disablePassword, setDisablePassword] = useState("");

  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  function loadStatus() {
    apiFetch("/auth/2fa/status")
      .then((res) => (res.ok ? res.json() : { enabled: false }))
      .then((data: { enabled: boolean }) => setStep(data.enabled ? "enabled" : "disabled"))
      .catch(() => setStep("disabled"));
  }

  function loadSessions() {
    setSessionsLoading(true);
    apiFetch("/auth/sessions")
      .then((res) => (res.ok ? res.json() : []))
      .then((data: ActiveSession[]) => setSessions(data))
      .catch(() => setSessions([]))
      .finally(() => setSessionsLoading(false));
  }

  useEffect(() => {
    // loadStatus/loadSessions setam loading de forma síncrona antes do fetch.
    /* eslint-disable react-hooks/set-state-in-effect */
    loadStatus();
    loadSessions();
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  async function handleRevokeSession(id: string) {
    setRevokingId(id);
    try {
      await apiFetch(`/auth/sessions/${id}`, { method: "DELETE" });
      setSessions((prev) => prev.filter((session) => session.id !== id));
    } finally {
      setRevokingId(null);
    }
  }

  async function handleStartSetup() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch("/auth/2fa/setup", { method: "POST" });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        throw new Error(translateApiError(t, body, security.errorSetupFailed));
      }
      const data = (await res.json()) as { secret: string; qrCodeDataUrl: string };
      setSecret(data.secret);
      setQrCodeDataUrl(data.qrCodeDataUrl);
      setStep("setting-up");
    } catch (err) {
      setError(err instanceof Error ? err.message : security.errorUnknown);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConfirmSetup(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch("/auth/2fa/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: confirmCode }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        throw new Error(translateApiError(t, body, security.errorInvalidCode));
      }
      const data = (await res.json()) as { backupCodes: string[] };
      setBackupCodes(data.backupCodes);
      setStep("showing-backup-codes");
    } catch (err) {
      setError(err instanceof Error ? err.message : security.errorUnknown);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDisable(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch("/auth/2fa/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: disablePassword }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        throw new Error(translateApiError(t, body, security.errorDisableFailed));
      }
      setDisablePassword("");
      setStep("disabled");
    } catch (err) {
      setError(err instanceof Error ? err.message : security.errorUnknown);
    } finally {
      setSubmitting(false);
    }
  }

  if (step === "loading") {
    return (
      <div className="mx-auto w-full max-w-2xl px-8 py-6">
        <p className="text-[13px] text-muted-foreground">{security.loading}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-8 py-6">
      <div className="mb-1 flex items-center gap-2">
        <ShieldCheck size={16} strokeWidth={1.75} className="text-foreground" />
        <h1 className="text-[15px] font-semibold text-foreground">{security.pageTitle}</h1>
      </div>
      <p className="mb-5 text-[12.5px] text-muted-foreground">{security.pageDescription}</p>

      {error && <p className="mb-3 text-[13px] text-destructive">{error}</p>}

      {step === "disabled" && (
        <div className="rounded-xl border border-border-subtle bg-surface p-5">
          <div className="flex items-center gap-2 text-muted-foreground">
            <ShieldOff size={16} strokeWidth={1.75} />
            <span className="text-[13.5px] font-medium text-foreground">{security.disabledTitle}</span>
          </div>
          <p className="mt-1.5 text-[12.5px] text-muted-foreground">{security.disabledDescription}</p>
          <button
            onClick={handleStartSetup}
            disabled={submitting}
            className="mt-3 inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-2 text-[13px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {security.enableButton}
          </button>
        </div>
      )}

      {step === "setting-up" && (
        <form
          onSubmit={handleConfirmSetup}
          className="flex flex-col gap-4 rounded-xl border border-border-subtle bg-surface p-5"
        >
          <p className="text-[13px] text-foreground">{security.setupStep1}</p>
          {qrCodeDataUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qrCodeDataUrl} alt={security.qrAlt} className="h-40 w-40 rounded-lg bg-white p-2" />
          )}
          <div>
            <p className="mb-1 text-[12px] text-muted-foreground">{security.manualCodeLabel}</p>
            <code className="break-all rounded-md bg-background px-2.5 py-1.5 font-mono text-[12.5px] text-foreground">
              {secret}
            </code>
          </div>

          <p className="text-[13px] text-foreground">{security.setupStep2}</p>
          <input
            value={confirmCode}
            onChange={(e) => setConfirmCode(e.target.value)}
            placeholder={security.codePlaceholder}
            required
            autoFocus
            className="w-40 rounded-md border border-border-subtle bg-transparent px-3 py-2 text-center font-mono text-[16px] tracking-widest text-foreground outline-none focus:border-accent"
          />

          <button
            type="submit"
            disabled={submitting}
            className="inline-flex w-fit items-center gap-2 rounded-md bg-accent px-3.5 py-2 text-[13px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {security.confirmButton}
          </button>
        </form>
      )}

      {step === "showing-backup-codes" && (
        <div className="rounded-xl border border-border-subtle bg-surface p-5">
          <div className="mb-3 flex items-start gap-2.5 rounded-lg bg-warning/10 p-3">
            <TriangleAlert size={16} strokeWidth={1.75} className="mt-0.5 flex-none text-warning" />
            <p className="text-[12.5px] text-warning">{security.backupCodesWarning}</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {backupCodes.map((code) => (
              <code key={code} className="rounded-md bg-background px-2.5 py-1.5 text-center font-mono text-[13px] text-foreground">
                {code}
              </code>
            ))}
          </div>
          <button
            onClick={() => setStep("enabled")}
            className="mt-4 rounded-md bg-accent px-3.5 py-2 text-[13px] font-semibold text-accent-foreground transition-opacity hover:opacity-90"
          >
            {security.backupCodesSavedButton}
          </button>
        </div>
      )}

      {step === "enabled" && (
        <form
          onSubmit={handleDisable}
          className="flex flex-col gap-3 rounded-xl border border-border-subtle bg-surface p-5"
        >
          <div className="flex items-center gap-2 text-accent">
            <ShieldCheck size={16} strokeWidth={1.75} />
            <span className="text-[13.5px] font-medium">{security.enabledTitle}</span>
          </div>
          <p className="text-[12.5px] text-muted-foreground">{security.enabledDescription}</p>
          <div className="flex items-center gap-2">
            <KeyRound size={14} className="flex-none text-muted-foreground" />
            <input
              type="password"
              value={disablePassword}
              onChange={(e) => setDisablePassword(e.target.value)}
              placeholder={security.passwordPlaceholder}
              required
              className="flex-1 rounded-md border border-border-subtle bg-transparent px-3 py-2 text-[13px] text-foreground outline-none focus:border-accent"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex w-fit items-center gap-2 rounded-md bg-destructive px-3.5 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {security.disableButton}
          </button>
        </form>
      )}

      <div className="mt-8 mb-1 flex items-center gap-2">
        <Laptop size={16} strokeWidth={1.75} className="text-foreground" />
        <h2 className="text-[15px] font-semibold text-foreground">{security.sessionsTitle}</h2>
      </div>
      <p className="mb-4 text-[12.5px] text-muted-foreground">{security.sessionsDescription}</p>

      <div className="rounded-xl border border-border-subtle bg-surface">
        {sessionsLoading ? (
          <p className="p-5 text-[13px] text-muted-foreground">{security.loading}</p>
        ) : sessions.length === 0 ? (
          <p className="p-5 text-[13px] text-muted-foreground">{security.noSessions}</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {sessions.map((session) => {
              const { label, isMobile } = describeUserAgent(session.userAgent, security);
              return (
                <li key={session.id} className="flex items-center gap-3 p-4">
                  {isMobile ? (
                    <Smartphone size={18} strokeWidth={1.75} className="flex-none text-muted-foreground" />
                  ) : (
                    <Laptop size={18} strokeWidth={1.75} className="flex-none text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13.5px] font-medium text-foreground">{label}</span>
                      {session.isCurrent && (
                        <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
                          {security.currentSessionBadge}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                      {security.lastUsedTemplate
                        .replace("{ip}", session.ipAddress ?? security.unknownIp)
                        .replace("{time}", formatRelativeTime(session.lastUsedAt, security))}
                    </p>
                  </div>
                  {!session.isCurrent && (
                    <button
                      onClick={() => handleRevokeSession(session.id)}
                      disabled={revokingId === session.id}
                      className="inline-flex flex-none items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1.5 text-[12.5px] font-medium text-destructive transition-opacity hover:opacity-80 disabled:opacity-50"
                    >
                      {revokingId === session.id ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <LogOut size={13} />
                      )}
                      {security.revokeButton}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
