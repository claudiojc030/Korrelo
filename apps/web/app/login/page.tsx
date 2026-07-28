"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { API_URL } from "../../lib/api-client";
import { setTokenClient } from "../../lib/auth-cookie-client";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"loading" | "login" | "setup">("loading");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido");
    } finally {
      setSubmitting(false);
    }
  }

  if (mode === "loading") {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-neutral-500">Carregando...</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">ForgeDesk</h1>
        <p className="mt-1 text-sm text-neutral-400">
          {mode === "setup" ? "Crie a conta de administrador" : "Entre na sua conta"}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex w-full max-w-sm flex-col gap-3">
        <input
          type="email"
          required
          placeholder="E-mail"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500"
        />
        <input
          type="password"
          required
          minLength={8}
          placeholder="Senha (mín. 8 caracteres)"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500"
        />

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
        >
          {submitting ? "Enviando..." : mode === "setup" ? "Criar conta" : "Entrar"}
        </button>
      </form>
    </main>
  );
}
