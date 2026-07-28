"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { GithubRepositorySummary } from "@forgedesk/shared-types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export function ImportFromGithub() {
  const router = useRouter();
  const [repos, setRepos] = useState<GithubRepositorySummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importingRepo, setImportingRepo] = useState<string | null>(null);

  async function loadRepos() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/github/repositories`);
      if (!res.ok) throw new Error("Não foi possível buscar os repositórios.");
      setRepos(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido");
    } finally {
      setLoading(false);
    }
  }

  async function importRepo(repo: GithubRepositorySummary) {
    setImportingRepo(repo.fullName);
    setError(null);
    try {
      const name = repo.fullName.split("/")[1] ?? repo.fullName;
      const createRes = await fetch(`${API_URL}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, repoUrl: repo.cloneUrl }),
      });
      if (!createRes.ok) throw new Error("Falha ao criar o projeto.");
      const project = (await createRes.json()) as { id: string };

      const importRes = await fetch(`${API_URL}/projects/${project.id}/import`, { method: "POST" });
      if (!importRes.ok) throw new Error("Falha ao importar/detectar a stack.");

      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido");
    } finally {
      setImportingRepo(null);
    }
  }

  if (repos === null) {
    return (
      <button
        onClick={loadRepos}
        disabled={loading}
        className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
      >
        {loading ? "Carregando..." : "Importar do GitHub"}
      </button>
    );
  }

  return (
    <div className="w-full max-w-xl">
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      <ul className="divide-y divide-neutral-800 rounded-md border border-neutral-800">
        {repos.map((repo) => (
          <li key={repo.fullName} className="flex items-center justify-between px-4 py-3">
            <span className="text-sm">
              {repo.fullName}
              {repo.private && <span className="ml-2 text-xs text-neutral-500">privado</span>}
            </span>
            <button
              onClick={() => importRepo(repo)}
              disabled={importingRepo === repo.fullName}
              className="rounded-md border border-neutral-700 px-3 py-1 text-xs hover:bg-neutral-800 disabled:opacity-50"
            >
              {importingRepo === repo.fullName ? "Importando..." : "Importar"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
