import Link from "next/link";
import { ExternalLink, SquareTerminal, FolderGit2 } from "lucide-react";
import type { DetectedStack, Project } from "@forgedesk/shared-types";
import { ImportFromGithub } from "./import-from-github";
import { DeployButton } from "./deploy-button";
import { DeleteProjectButton } from "./delete-project-button";
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

const STATUS_LABEL: Record<Project["status"], string> = {
  detected: "Detectado",
  configuring: "Configurando",
  running: "Rodando",
  stopped: "Parado",
  failed: "Falhou",
};

function ProjectCard({ project, accent }: { project: Project; accent: "good" | "bad" | "none" }) {
  const stack = parseStack(project);
  const borderClass =
    accent === "good" ? "border-l-2 border-l-accent" : accent === "bad" ? "border-l-2 border-l-destructive" : "";

  return (
    <li
      className={`flex flex-col rounded-xl border border-border-subtle bg-surface p-4 ${borderClass}`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="truncate font-medium text-foreground">{project.name}</p>
        <DeleteProjectButton projectId={project.id} projectName={project.name} />
      </div>
      <p className="-mt-1 truncate text-[12px] text-muted-foreground">{project.repoUrl}</p>
      {project.status !== "running" && (
        <p className="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground/70">
          {STATUS_LABEL[project.status]}
        </p>
      )}

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
          <>
            {project.status === "failed" && (
              <span className="text-[12.5px] text-destructive">O deploy falhou.</span>
            )}
            {stack && <DeployButton projectId={project.id} />}
          </>
        )}
      </div>
    </li>
  );
}

function Section({
  title,
  count,
  accent,
  projects,
}: {
  title: string;
  count: number;
  accent: "good" | "bad" | "none";
  projects: Project[];
}) {
  if (projects.length === 0) return null;

  return (
    <div className="mb-8">
      <div className="mb-2.5 flex items-center gap-2">
        <h2 className="text-[13px] font-medium text-muted-foreground">{title}</h2>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
          {count}
        </span>
      </div>
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {projects.map((project) => (
          <ProjectCard key={project.id} project={project} accent={accent} />
        ))}
      </ul>
    </div>
  );
}

export default async function ProjectsPage() {
  const projects = await getProjects();

  const running = projects.filter((p) => p.status === "running");
  const failed = projects.filter((p) => p.status === "failed");
  const pending = projects.filter((p) => p.status !== "running" && p.status !== "failed");

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Projetos</h1>
          <p className="mt-0.5 text-[13.5px] text-muted-foreground">
            Importe do GitHub e implante com um clique.
          </p>
        </div>
        <ImportFromGithub />
      </div>

      {projects.length > 0 && (
        <p className="mb-8 mt-4 text-[13px] text-muted-foreground">
          <span className="font-medium text-foreground">{projects.length}</span> projeto
          {projects.length === 1 ? "" : "s"} ·{" "}
          <span className="font-medium text-accent">{running.length} rodando</span>
          {failed.length > 0 && (
            <>
              {" "}
              · <span className="font-medium text-destructive">{failed.length} falhou</span>
            </>
          )}
        </p>
      )}

      {projects.length === 0 ? (
        <div className="mt-4 flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
          <FolderGit2 size={22} strokeWidth={1.5} className="text-muted-foreground" />
          <p className="text-[13.5px] text-muted-foreground">
            Nenhum projeto ainda — importe um repositório do GitHub pra começar.
          </p>
        </div>
      ) : (
        <>
          <Section title="Rodando" count={running.length} accent="good" projects={running} />
          <Section title="Aguardando deploy" count={pending.length} accent="none" projects={pending} />
          <Section title="Falharam" count={failed.length} accent="bad" projects={failed} />
        </>
      )}
    </div>
  );
}
