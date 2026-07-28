import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { Project } from "@forgedesk/shared-types";
import { ProjectTabs } from "./project-tabs";
import { authHeaderServer } from "../../../../lib/auth-cookie-server";

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

const STATUS_STYLE: Record<Project["status"], { label: string; dot: string; text: string }> = {
  detected: { label: "Detectado", dot: "bg-muted-foreground", text: "text-muted-foreground" },
  configuring: { label: "Configurando", dot: "bg-warning", text: "text-warning" },
  running: { label: "Rodando", dot: "bg-accent", text: "text-accent" },
  stopped: { label: "Parado", dot: "bg-muted-foreground", text: "text-muted-foreground" },
  failed: { label: "Falhou", dot: "bg-destructive", text: "text-destructive" },
};

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { projectId: string };
}) {
  const project = await getProject(params.projectId);

  if (!project) {
    return (
      <div className="mx-auto max-w-5xl px-8 py-10">
        <p className="text-[13.5px] text-destructive">Projeto não encontrado.</p>
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
          Projetos
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
        <ProjectTabs projectId={project.id} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
