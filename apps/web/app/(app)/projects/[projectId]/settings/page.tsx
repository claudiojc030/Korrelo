"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import type { Project } from "@korrelo/shared-types";
import { apiFetch } from "../../../../../lib/api-client";
import { useTranslation } from "../../../../../lib/i18n/locale-provider";

function FeatureToggleRow({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border-subtle py-4 last:border-0">
      <div>
        <p className="text-[13.5px] font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 flex-none rounded-full transition-colors disabled:opacity-50 ${
          checked ? "bg-accent" : "bg-muted"
        }`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
            checked ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}

export default function ProjectSettingsPage(props: { params: Promise<{ projectId: string }> }) {
  const params = use(props.params);
  const router = useRouter();
  const { t } = useTranslation();
  const [project, setProject] = useState<Project | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [branchInput, setBranchInput] = useState("");

  function load() {
    apiFetch(`/projects/${params.projectId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((p: Project | null) => {
        setProject(p);
        if (p) setBranchInput(p.deployBranch);
      })
      .catch(() => setProject(null));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.projectId]);

  async function updateSettings(patch: {
    terminalEnabled?: boolean;
    databaseEnabled?: boolean;
    autoDeployEnabled?: boolean;
    deployBranch?: string;
  }) {
    if (!project) return;
    setSaving(true);
    setProject({ ...project, ...patch });
    try {
      await apiFetch(`/projects/${params.projectId}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  if (project === undefined) {
    return (
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <p className="text-[13px] text-muted-foreground">{t.common.loading}</p>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <p className="text-[13px] text-destructive">{t.projectSettings.loadError}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-6">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-[13.5px] font-medium text-foreground">{t.projectSettings.featuresTitle}</p>
        {saving && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
      </div>
      <p className="mb-2 text-[12.5px] text-muted-foreground">{t.projectSettings.featuresSubtitle}</p>
      <div className="rounded-xl border border-border-subtle bg-surface px-4">
        <FeatureToggleRow
          title={t.projectSettings.databaseTitle}
          description={t.projectSettings.databaseDescription}
          checked={project.databaseEnabled}
          disabled={saving}
          onChange={(value) => updateSettings({ databaseEnabled: value })}
        />
        <FeatureToggleRow
          title={t.projectSettings.terminalTitle}
          description={t.projectSettings.terminalDescription}
          checked={project.terminalEnabled}
          disabled={saving}
          onChange={(value) => updateSettings({ terminalEnabled: value })}
        />
      </div>

      <p className="mb-2 mt-6 text-[13.5px] font-medium text-foreground">{t.projectSettings.autoDeployTitle}</p>
      <p className="mb-2 text-[12.5px] text-muted-foreground">
        {t.projectSettings.webhookDescriptionPrefix}{" "}
        <code className="font-mono text-foreground">/github/webhook</code> {t.projectSettings.webhookDescriptionSuffix}
      </p>
      <div className="rounded-xl border border-border-subtle bg-surface px-4">
        <FeatureToggleRow
          title={t.projectSettings.pushDeployTitle}
          description={t.projectSettings.pushDeployDescription}
          checked={project.autoDeployEnabled}
          disabled={saving}
          onChange={(value) => updateSettings({ autoDeployEnabled: value })}
        />
        <div className="flex items-center justify-between py-4">
          <div>
            <p className="text-[13.5px] font-medium text-foreground">{t.projectSettings.branchTitle}</p>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">{t.projectSettings.branchDescription}</p>
          </div>
          <div className="flex items-center gap-2">
            <input
              value={branchInput}
              onChange={(e) => setBranchInput(e.target.value)}
              placeholder={t.projectSettings.branchPlaceholder}
              className="w-32 rounded-md border border-border-subtle bg-transparent px-2.5 py-1.5 font-mono text-[13px] text-foreground outline-none focus:border-accent"
            />
            <button
              onClick={() => updateSettings({ deployBranch: branchInput })}
              disabled={saving || branchInput === project.deployBranch}
              className="rounded-md border border-border-subtle px-2.5 py-1.5 text-[12.5px] font-medium text-foreground hover:bg-muted disabled:opacity-50"
            >
              {t.common.save}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
