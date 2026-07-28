"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { API_URL } from "../../lib/api-client";
import { setTokenClient } from "../../lib/auth-cookie-client";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"loading" | "login" | "setup">("loading");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/auth/has-user`)
      .then((res) => res.json())
      .then((data: { hasUser: boolean }) => setMode(data.hasUser ? "login" : "setup"))
      .catch(() => setMode("login"));
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const endpoint = mode === "setup" ? "/auth/register" : "/auth/login";
      const res = await fetch(`${API_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "Falha ao autenticar.");
      }

      const data = (await res.json()) as { accessToken: string };
      setTokenClient(data.accessToken);
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido");
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
            <h1 className="text-lg font-semibold text-foreground">ForgeDesk</h1>
            <p className="mt-1 text-[13.5px] text-muted-foreground">
              {mode === "loading"
                ? "Carregando..."
                : mode === "setup"
                  ? "Crie a conta de administrador desta VPS"
                  : "Entre com sua conta de administrador"}
            </p>
          </div>
        </div>

        {mode !== "loading" && (
          <form
            onSubmit={handleSubmit}
            className="flex flex-col gap-4 rounded-xl border border-border-subtle bg-surface p-6 shadow-panel"
          >
            <div className="flex flex-col gap-1.5">
              <label htmlFor="email" className="text-[13px] font-medium text-muted-foreground">
                E-mail
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                placeholder="voce@exemplo.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="rounded-md border border-border bg-background px-3 py-2 text-[14px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-accent"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="password" className="text-[13px] font-medium text-muted-foreground">
                Senha
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  required
                  minLength={8}
                  autoComplete={mode === "setup" ? "new-password" : "current-password"}
                  placeholder="Mínimo 8 caracteres"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 pr-10 text-[14px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-accent"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
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
              {mode === "setup" ? "Criar conta" : "Entrar"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
