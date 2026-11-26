"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Rocket, Loader2, Search } from "lucide-react";
import { apiFetch } from "../../../lib/api-client";
import { useTranslation } from "../../../lib/i18n/locale-provider";
import { translateApiError } from "../../../lib/api-error";

const FULL_SHA = /^[a-f0-9]{40}$/i;

interface PreviewResult {
  smartDeploy?: {
    strategy: "sequential" | "legacy";
    projectAuthorized: boolean;
    commitPinned: boolean;
    estimates: {
      requiredHostMemoryMb: number | null;
      availableForBuildMb: number | null;
    };
    waitReasons: string[];
    isolation?: {
      level: "isolated" | "shared";
      sharedResources: string[];
      isolationRequired: boolean;
      blocker: string | null;
    };
  };
  warnings?: string[];
}

export function DeployButton({ projectId, onDeployed }: { projectId: string; onDeployed?: () => void }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [commit, setCommit] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<{
    branch: string;
    commitSha: string;
    shortSha: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function normalizedCommit(): string | null {
    const value = commit.trim().toLowerCase();
    if (!value) return null;
    return FULL_SHA.test(value) ? value : "";
  }

  async function handleDiscoverCommit() {
    setDiscovering(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch(`/projects/${projectId}/deploy-commit`, { method: "GET" });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        throw new Error(translateApiError(t, body, t.projects.deployError));
      }
      const body = (await res.json()) as {
        branch: string;
        commitSha: string;
        shortSha: string;
      };
      setCommit(body.commitSha);
      setDiscovered(body);
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.projects.unknownError);
    } finally {
      setDiscovering(false);
    }
  }

  async function handlePreview() {
    setError(null);
    setNotice(null);
    const sha = normalizedCommit();
    if (sha === "") {
      setError(t.projectDetail.deployInvalidCommit);
      return;
    }
    if (!sha) {
      setError(t.projectDetail.deployPreviewCommitRequired);
      return;
    }
    setPreviewing(true);
    try {
      const res = await apiFetch(
        `/projects/${projectId}/deploy-dry-run?commit=${encodeURIComponent(sha)}`,
        { method: "GET" },
      );
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        throw new Error(translateApiError(t, body, t.projects.deployError));
      }
      setPreview((await res.json().catch(() => null)) as PreviewResult | null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.projects.unknownError);
    } finally {
      setPreviewing(false);
    }
  }

  async function handleDeploy() {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const sha = normalizedCommit();
      if (sha === "") {
        setError(t.projectDetail.deployInvalidCommit);
        return;
      }
      if (!sha) {
        setError(t.projectDetail.deployPreviewCommitRequired);
        return;
      }
      const res = await apiFetch(`/projects/${projectId}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commit: sha }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        throw new Error(translateApiError(t, body, t.projects.deployError));
      }
      const body = (await res.json().catch(() => null)) as
        | { created?: boolean; deferred?: boolean }
        | null;
      setNotice(
        body?.deferred
          ? t.projectDetail.deployDeferred
          : body?.created === false
            ? t.projectDetail.deployAlreadyQueued
            : null,
      );
      router.refresh();
      onDeployed?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.projects.unknownError);
    } finally {
      setLoading(false);
    }
  }

  const smart = preview?.smartDeploy;

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
        {t.projectDetail.deployCommitLabel}
        <input
          value={commit}
          onChange={(event) => {
            setCommit(event.target.value);
            setPreview(null);
          }}
          placeholder={t.projectDetail.deployCommitPlaceholder}
          spellCheck={false}
          className="rounded-md border border-border-subtle bg-background px-2 py-1 font-mono text-[12px] text-foreground outline-none focus:border-accent"
        />
      </label>
      <div className="flex items-center gap-3">
        <button
          onClick={handleDiscoverCommit}
          disabled={discovering || previewing || loading}
          className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {discovering ? <Loader2 size={13} className="animate-spin" /> : null}
          {discovering ? t.projectDetail.deployDiscovering : t.projectDetail.deployDiscoverCommit}
        </button>
        <button
          onClick={handlePreview}
          disabled={previewing || loading || discovering}
          className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {previewing ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} strokeWidth={1.75} />}
          {previewing ? t.projectDetail.deployPreviewLoading : t.projectDetail.deployPreview}
        </button>
        <button
          onClick={handleDeploy}
          disabled={loading || previewing || discovering}
          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-accent hover:opacity-85 disabled:opacity-50"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} strokeWidth={1.75} />}
          {loading ? t.projects.deploying : t.projects.deployAction}
        </button>
      </div>

      {discovered && (
        <p className="text-[11.5px] text-muted-foreground">
          {t.projectDetail.deployBranchLabel}: <span className="font-mono text-foreground">{discovered.branch}</span>
          {" · "}
          {t.projectDetail.deployCommitShort}:{" "}
          <span className="font-mono text-foreground">{discovered.shortSha}</span>
        </p>
      )}

      {smart && (
        <div className="rounded-md border border-border-subtle bg-background p-2 text-[11.5px] text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">{t.projectDetail.deployStrategy}: </span>
            {smart.strategy === "sequential"
              ? t.projectDetail.deployStrategySequential
              : t.projectDetail.deployStrategyLegacy}
          </p>
          <p>
            {t.projectDetail.deployPreviewMemory
              .replace("{required}", String(smart.estimates.requiredHostMemoryMb ?? "-"))
              .replace("{available}", String(smart.estimates.availableForBuildMb ?? "-"))}
          </p>
          {smart.waitReasons.length > 0 && (
            <p>
              {t.projectDetail.deployPreviewWait.replace("{reason}", smart.waitReasons.join("; "))}
            </p>
          )}
          {smart.isolation && smart.isolation.sharedResources.length > 0 && (
            <p>
              {t.projectDetail.deployPreviewShared.replace(
                "{resources}",
                smart.isolation.sharedResources.join(", "),
              )}
            </p>
          )}
        </div>
      )}

      {notice && <p className="text-[12px] text-muted-foreground">{notice}</p>}
      {error && <p className="text-[12px] text-destructive">{error}</p>}
    </div>
  );
}
