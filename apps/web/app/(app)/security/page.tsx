"use client";

import { useEffect, useState } from "react";
import { KeyRound, Loader2, ShieldCheck, ShieldOff, TriangleAlert } from "lucide-react";
import { apiFetch } from "../../../lib/api-client";

type Step = "loading" | "disabled" | "setting-up" | "showing-backup-codes" | "enabled";

export default function SecurityPage() {
  const [step, setStep] = useState<Step>("loading");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [secret, setSecret] = useState("");
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState("");
  const [confirmCode, setConfirmCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);

  const [disablePassword, setDisablePassword] = useState("");

  function loadStatus() {
    apiFetch("/auth/2fa/status")
      .then((res) => (res.ok ? res.json() : { enabled: false }))
      .then((data: { enabled: boolean }) => setStep(data.enabled ? "enabled" : "disabled"))
      .catch(() => setStep("disabled"));
  }

  useEffect(() => {
    loadStatus();
  }, []);

  async function handleStartSetup() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch("/auth/2fa/setup", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "Falha ao iniciar configuração.");
      }
      const data = (await res.json()) as { secret: string; qrCodeDataUrl: string };
      setSecret(data.secret);
      setQrCodeDataUrl(data.qrCodeDataUrl);
      setStep("setting-up");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido");
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
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "Código inválido.");
      }
      const data = (await res.json()) as { backupCodes: string[] };
      setBackupCodes(data.backupCodes);
      setStep("showing-backup-codes");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido");
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
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "Falha ao desativar.");
      }
      setDisablePassword("");
      setStep("disabled");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido");
    } finally {
      setSubmitting(false);
    }
  }

  if (step === "loading") {
    return (
      <div className="mx-auto w-full max-w-2xl px-8 py-6">
        <p className="text-[13px] text-muted-foreground">Carregando...</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-8 py-6">
      <div className="mb-1 flex items-center gap-2">
        <ShieldCheck size={16} strokeWidth={1.75} className="text-foreground" />
        <h1 className="text-[15px] font-semibold text-foreground">Segurança da conta</h1>
      </div>
      <p className="mb-5 text-[12.5px] text-muted-foreground">
        Autenticação em duas etapas (2FA) exige um código do seu app autenticador (Google Authenticator, Authy,
        etc) além da senha pra entrar no ForgeDesk.
      </p>

      {error && <p className="mb-3 text-[13px] text-destructive">{error}</p>}

      {step === "disabled" && (
        <div className="rounded-xl border border-border-subtle bg-surface p-5">
          <div className="flex items-center gap-2 text-muted-foreground">
            <ShieldOff size={16} strokeWidth={1.75} />
            <span className="text-[13.5px] font-medium text-foreground">2FA desativado</span>
          </div>
          <p className="mt-1.5 text-[12.5px] text-muted-foreground">
            Sua conta só é protegida por senha no momento.
          </p>
          <button
            onClick={handleStartSetup}
            disabled={submitting}
            className="mt-3 inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-2 text-[13px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            Ativar 2FA
          </button>
        </div>
      )}

      {step === "setting-up" && (
        <form
          onSubmit={handleConfirmSetup}
          className="flex flex-col gap-4 rounded-xl border border-border-subtle bg-surface p-5"
        >
          <p className="text-[13px] text-foreground">
            1. Escaneie o QR code com seu app autenticador (ou digite o código manualmente).
          </p>
          {qrCodeDataUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qrCodeDataUrl} alt="QR code do 2FA" className="h-40 w-40 rounded-lg bg-white p-2" />
          )}
          <div>
            <p className="mb-1 text-[12px] text-muted-foreground">Código manual</p>
            <code className="break-all rounded-md bg-background px-2.5 py-1.5 font-mono text-[12.5px] text-foreground">
              {secret}
            </code>
          </div>

          <p className="text-[13px] text-foreground">2. Digite o código de 6 dígitos que apareceu no app:</p>
          <input
            value={confirmCode}
            onChange={(e) => setConfirmCode(e.target.value)}
            placeholder="123456"
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
            Confirmar e ativar
          </button>
        </form>
      )}

      {step === "showing-backup-codes" && (
        <div className="rounded-xl border border-border-subtle bg-surface p-5">
          <div className="mb-3 flex items-start gap-2.5 rounded-lg bg-warning/10 p-3">
            <TriangleAlert size={16} strokeWidth={1.75} className="mt-0.5 flex-none text-warning" />
            <p className="text-[12.5px] text-warning">
              Guarde esses códigos de backup agora — eles não vão aparecer de novo. Cada um só funciona uma vez,
              e servem pra entrar caso você perca acesso ao app autenticador.
            </p>
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
            Já salvei os códigos
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
            <span className="text-[13.5px] font-medium">2FA ativado</span>
          </div>
          <p className="text-[12.5px] text-muted-foreground">
            Digite sua senha pra desativar (isso remove a exigência do código no login).
          </p>
          <div className="flex items-center gap-2">
            <KeyRound size={14} className="flex-none text-muted-foreground" />
            <input
              type="password"
              value={disablePassword}
              onChange={(e) => setDisablePassword(e.target.value)}
              placeholder="Sua senha"
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
            Desativar 2FA
          </button>
        </form>
      )}
    </div>
  );
}
