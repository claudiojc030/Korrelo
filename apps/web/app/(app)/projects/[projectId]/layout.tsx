import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { Project } from "@korrelo/shared-types";
import { ProjectTabs } from "./project-tabs";
import { authHeaderServer } from "../../../../lib/auth-cookie-server";
import { getLocaleServer } from "../../../../lib/i18n/get-locale-server";
import { getDictionary } from "../../../../lib/i18n/dictionaries";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

async function getProject(projectId: string): Promise<Project | null> {
  try {
    const res = await fetch(`${API_URL}/projects/${projectId}`, {
      cache: "no-store",
      headers: authHeaderServer(),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { projectId: string };
}) {
  const t = getDictionary(getLocaleServer());
  const STATUS_STYLE: Record<Project["status"], { label: string; dot: string; text: string }> = {
    detected: { label: t.projectDetail.statusDetected, dot: "bg-muted-foreground", text: "text-muted-foreground" },
    configuring: { label: t.projectDetail.statusConfiguring, dot: "bg-warning", text: "text-warning" },
    running: { label: t.projectDetail.statusRunning, dot: "bg-accent", text: "text-accent" },
    stopped: { label: t.projectDetail.statusStopped, dot: "bg-muted-foreground", text: "text-muted-foreground" },
    failed: { label: t.projectDetail.statusFailed, dot: "bg-destructive", text: "text-destructive" },
  };

  const project = await getProject(params.projectId);

  if (!project) {
    return (
      <div className="mx-auto max-w-5xl px-8 py-10">
        <p className="text-[13.5px] text-destructive">{t.projectDetail.projectNotFound}</p>
      </div>
    );
  }

  const status = STATUS_STYLE[project.status];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-8 pt-8">
        <Link
          href="/projects"
          className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={14} strokeWidth={1.75} />
          {t.projectDetail.backToProjects}
        </Link>
        <div className="mt-2 flex items-center gap-2.5">
          <h1 className="text-xl font-semibold text-foreground">{project.name}</h1>
          <span className={`flex items-center gap-1.5 text-[12.5px] font-medium ${status.text}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
            {status.label}
          </span>
        </div>
      </div>

      <div className="mt-5 border-b border-border-subtle">
        <ProjectTabs
          projectId={project.id}
          terminalEnabled={project.terminalEnabled}
          databaseEnabled={project.databaseEnabled}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
