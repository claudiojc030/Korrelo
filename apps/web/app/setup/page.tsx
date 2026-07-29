"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Loader2, Sparkles } from "lucide-react";
import { apiFetch } from "../../lib/api-client";
import { useTranslation } from "../../lib/i18n/locale-provider";
import { translateApiError } from "../../lib/api-error";

export default function SetupPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiFetch(`/auth/has-user`)
      .then((res) => res.json())
      .then((data: { hasUser: boolean }) => {
        if (data.hasUser) {
          router.replace("/login");
          return;
        }
        setReady(true);
      })
      .catch(() => setReady(true));
  }, [router]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const res = await apiFetch("/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (!res.ok) {
        const respBody: unknown = await res.json().catch(() => ({}));
        throw new Error(translateApiError(t, respBody, t.setup.authFailedFallback));
      }

      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.setup.unknownError);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-[380px]">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent font-mono text-base font-semibold text-accent-foreground">
            &gt;_
          </div>
          <div>
            <h1 className="text-lg font-semibold text-foreground">Korrelo</h1>
            <p className="mt-1 text-[13.5px] text-muted-foreground">{ready ? t.setup.welcomeSubtitle : t.setup.loadingSubtitle}</p>
          </div>
        </div>

        {ready && (
          <form
            onSubmit={handleSubmit}
            className="flex flex-col gap-4 rounded-xl border border-border-subtle bg-surface p-6 shadow-panel"
          >
            <div className="flex items-center gap-2 rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-[12.5px] text-accent">
              <Sparkles size={14} className="flex-none" />
              {t.setup.welcomeTitle}
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="username" className="text-[13px] font-medium text-muted-foreground">
                {t.setup.usernameLabel}
              </label>
              <input
                id="username"
                type="text"
                required
                autoFocus
                autoComplete="username"
                placeholder={t.setup.usernamePlaceholder}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                className="rounded-md border border-border bg-background px-3 py-2 text-[14px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-accent"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="password" className="text-[13px] font-medium text-muted-foreground">
                {t.setup.passwordLabel}
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  placeholder={t.setup.passwordPlaceholder}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 pr-10 text-[14px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-accent"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? t.setup.hidePassword : t.setup.showPassword}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {error && (
              <p role="alert" className="text-[13px] text-destructive">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="mt-1 inline-flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {submitting && <Loader2 size={15} className="animate-spin" />}
              {t.setup.submitCreateAccount}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
