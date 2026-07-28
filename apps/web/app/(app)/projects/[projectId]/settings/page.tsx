"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import type { Project } from "@forgedesk/shared-types";
import { apiFetch } from "../../../../../lib/api-client";

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

export default function ProjectSettingsPage({ params }: { params: { projectId: string } }) {
  const router = useRouter();
  const [project, setProject] = useState<Project | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  function load() {
    apiFetch(`/projects/${params.projectId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then(setProject)
      .catch(() => setProject(null));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.projectId]);

  async function updateSettings(patch: { terminalEnabled?: boolean; databaseEnabled?: boolean }) {
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
        <p className="text-[13px] text-muted-foreground">Carregando...</p>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <p className="text-[13px] text-destructive">Não foi possível carregar as configurações.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-6">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-[13.5px] font-medium text-foreground">Funcionalidades deste projeto</p>
        {saving && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
      </div>
      <p className="mb-2 text-[12.5px] text-muted-foreground">
        Nem todo projeto precisa de tudo. Desative o que não for usar — a aba correspondente some da navegação.
      </p>
      <div className="rounded-xl border border-border-subtle bg-surface px-4">
        <FeatureToggleRow
          title="Banco de Dados"
          description="Provisionar ou conectar um banco de dados pra este projeto."
          checked={project.databaseEnabled}
          disabled={saving}
          onChange={(value) => updateSettings({ databaseEnabled: value })}
        />
        <FeatureToggleRow
          title="Terminal"
          description="Acesso a um terminal do container deste projeto direto pelo navegador."
          checked={project.terminalEnabled}
          disabled={saving}
          onChange={(value) => updateSettings({ terminalEnabled: value })}
        />
      </div>
    </div>
  );
}
