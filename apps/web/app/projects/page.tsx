import type { DetectedStack, Project } from "@forgedesk/shared-types";
import { ImportFromGithub } from "./import-from-github";
import { DeployButton } from "./deploy-button";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

async function getProjects(): Promise<Project[]> {
  const res = await fetch(`${API_URL}/projects`, { cache: "no-store" });
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

function ProjectCard({ project }: { project: Project }) {
  const stack = parseStack(project);

  return (
    <li className="rounded-md border border-neutral-800 px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="font-medium">{project.name}</span>
        <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-xs text-neutral-400">
          {STATUS_LABEL[project.status]}
        </span>
      </div>
      <p className="mt-1 truncate text-xs text-neutral-500">{project.repoUrl}</p>
      {stack && (
        <p className="mt-2 text-sm text-neutral-300">
          {stack.language}
          {stack.framework ? ` · ${stack.framework}` : ""}
          {stack.packageManager ? ` · ${stack.packageManager}` : ""}
          {stack.recommendedPort ? ` · porta ${stack.recommendedPort}` : ""}
        </p>
      )}
      {project.status === "running" && project.assignedPort ? (
        <a
          href={`http://localhost:${project.assignedPort}`}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block text-sm text-green-400 underline"
        >
          Rodando em localhost:{project.assignedPort}
        </a>
      ) : (
        stack && <DeployButton projectId={project.id} />
      )}
    </li>
  );
}

export default async function ProjectsPage() {
  const projects = await getProjects();

  return (
    <main className="flex min-h-screen flex-col items-center gap-8 px-4 py-16">
      <h1 className="text-2xl font-semibold">Projetos</h1>

      <ImportFromGithub />

      <div className="w-full max-w-xl">
        {projects.length === 0 ? (
          <p className="text-center text-sm text-neutral-500">Nenhum projeto ainda.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
