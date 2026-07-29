"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Github, Lock, Loader2 } from "lucide-react";
import type { GithubRepositorySummary } from "@korrelo/shared-types";
import { apiFetch } from "../../../lib/api-client";
import { useTranslation } from "../../../lib/i18n/locale-provider";
import { translateApiError } from "../../../lib/api-error";

export function ImportFromGithub() {
  const { t } = useTranslation();
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [repos, setRepos] = useState<GithubRepositorySummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importingRepo, setImportingRepo] = useState<string | null>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function handleOpen() {
    setOpen(true);
    if (repos !== null) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/github/repositories");
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        throw new Error(translateApiError(t, body, t.projects.fetchReposError));
      }
      setRepos(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : t.projects.unknownError);
    } finally {
      setLoading(false);
    }
  }

  async function importRepo(repo: GithubRepositorySummary) {
    setImportingRepo(repo.fullName);
    setError(null);
    try {
      const name = repo.fullName.split("/")[1] ?? repo.fullName;
      const createRes = await apiFetch("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, repoUrl: repo.cloneUrl }),
      });
      if (!createRes.ok) {
        const body: unknown = await createRes.json().catch(() => ({}));
        throw new Error(translateApiError(t, body, t.projects.createProjectError));
      }
      const project = (await createRes.json()) as { id: string };

      const importRes = await apiFetch(`/projects/${project.id}/import`, { method: "POST" });
      if (!importRes.ok) {
        const body: unknown = await importRes.json().catch(() => ({}));
        throw new Error(translateApiError(t, body, t.projects.importDetectError));
      }

      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.projects.unknownError);
    } finally {
      setImportingRepo(null);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={handleOpen}
        className="inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-2 text-[13px] font-semibold text-accent-foreground transition-opacity hover:opacity-90"
      >
        <Github size={15} strokeWidth={2} />
        {t.projects.importButton}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-20 mt-2 w-80 rounded-xl border border-border-subtle bg-surface p-2 shadow-panel">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-6 text-[13px] text-muted-foreground">
              <Loader2 size={15} className="animate-spin" />
              {t.projects.fetchingRepos}
            </div>
          )}

          {error && <p className="px-2 py-2 text-[12.5px] text-destructive">{error}</p>}

          {!loading && repos && repos.length === 0 && (
            <p className="px-2 py-4 text-center text-[12.5px] text-muted-foreground">
              {t.projects.noReposAvailable}
            </p>
          )}

          {!loading && repos && repos.length > 0 && (
            <ul className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
              {repos.map((repo) => (
                <li key={repo.fullName}>
                  <button
                    onClick={() => importRepo(repo)}
                    disabled={importingRepo === repo.fullName}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-muted disabled:opacity-50"
                  >
                    <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-foreground">
                      <span className="truncate">{repo.fullName}</span>
                      {repo.private && <Lock size={11} className="flex-none text-muted-foreground" />}
                    </span>
                    {importingRepo === repo.fullName && (
                      <Loader2 size={13} className="flex-none animate-spin text-muted-foreground" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
