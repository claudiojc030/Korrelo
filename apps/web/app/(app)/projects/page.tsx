import Link from "next/link";
import { ExternalLink, SquareTerminal, FolderGit2 } from "lucide-react";
import type { DetectedStack, Project } from "@forgedesk/shared-types";
import { ImportFromGithub } from "./import-from-github";
import { DeployButton } from "./deploy-button";
import { authHeaderServer } from "../../../lib/auth-cookie-server";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

async function getProjects(): Promise<Project[]> {
  const res = await fetch(`${API_URL}/projects`, { cache: "no-store", headers: authHeaderServer() });
  if (!res.ok) return [];
  return res.json();
}

function parseStack(project: Project): DetectedStack | null {
  if (!project.detectedStack) return null;
  try {
    return JSON.parse(project.detectedStack) as DetectedStack;
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

function ProjectCard({ project }: { project: Project }) {
  const stack = parseStack(project);
  const status = STATUS_STYLE[project.status];

  return (
    <li className="flex flex-col rounded-xl border border-border-subtle bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="truncate font-medium text-foreground">{project.name}</p>
        <span className={`flex flex-none items-center gap-1.5 text-[12px] font-medium ${status.text}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
          {status.label}
        </span>
      </div>
      <p className="mt-1 truncate text-[12px] text-muted-foreground">{project.repoUrl}</p>

      {stack && (
        <p className="mt-2.5 text-[13px] text-muted-foreground">
          {stack.language}
          {stack.framework ? ` · ${stack.framework}` : ""}
          {stack.packageManager ? ` · ${stack.packageManager}` : ""}
          {stack.recommendedPort ? ` · porta ${stack.recommendedPort}` : ""}
        </p>
      )}

      <div className="mt-3 flex items-center gap-4 border-t border-border-subtle pt-3">
        {project.status === "running" && project.assignedPort ? (
          <>
            <a
              href={`http://localhost:${project.assignedPort}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-[13px] font-medium text-accent hover:opacity-85"
            >
              <ExternalLink size={14} strokeWidth={1.75} />
              localhost:{project.assignedPort}
            </a>
            <Link
              href={`/projects/${project.id}/terminal`}
              className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground"
            >
              <SquareTerminal size={14} strokeWidth={1.75} />
              Terminal
            </Link>
          </>
        ) : (
          stack && <DeployButton projectId={project.id} />
        )}
      </div>
    </li>
  );
}

export default async function ProjectsPage() {
  const projects = await getProjects();

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Projetos</h1>
          <p className="mt-0.5 text-[13.5px] text-muted-foreground">
            Importe do GitHub e implante com um clique.
          </p>
        </div>
        <ImportFromGithub />
      </div>

      {projects.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
          <FolderGit2 size={22} strokeWidth={1.5} className="text-muted-foreground" />
          <p className="text-[13.5px] text-muted-foreground">
            Nenhum projeto ainda — importe um repositório do GitHub pra começar.
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </ul>
      )}
    </div>
  );
}
