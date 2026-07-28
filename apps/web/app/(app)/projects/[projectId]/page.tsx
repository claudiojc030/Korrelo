import { ExternalLink, GitBranch, Cpu, MemoryStick, HardDrive } from "lucide-react";
import { CONTAINER_MEMORY_LIMIT_MB, type DetectedStack, type Project, type SystemMetrics } from "@forgedesk/shared-types";
import { authHeaderServer } from "../../../../lib/auth-cookie-server";
import { DomainCard } from "./domain-card";

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

async function getDiskUsage(projectId: string): Promise<number | null> {
  try {
    const res = await fetch(`${API_URL}/projects/${projectId}/disk-usage`, {
      cache: "no-store",
      headers: authHeaderServer(),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { diskUsageMb: number };
    return data.diskUsageMb;
  } catch {
    return null;
  }
}

async function getSystemMetrics(): Promise<SystemMetrics | null> {
  try {
    const res = await fetch(`${API_URL}/monitoring/system`, {
      cache: "no-store",
      headers: authHeaderServer(),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function parseStack(project: Project): DetectedStack | null {
  if (!project.detectedStack) return null;
  try {
    return JSON.parse(project.detectedStack) as DetectedStack;
  } catch {
    return null;
  }
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border-subtle py-2.5 last:border-0">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="text-[13px] text-foreground">{value}</span>
    </div>
  );
}

export default async function ProjectSummaryPage({ params }: { params: { projectId: string } }) {
  const [project, diskUsageMb, metrics] = await Promise.all([
    getProject(params.projectId),
    getDiskUsage(params.projectId),
    getSystemMetrics(),
  ]);

  if (!project) return null;

  const stack = parseStack(project);
  const container = project.containerName
    ? metrics?.containers.find((c) => c.name === project.containerName)
    : undefined;

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-6">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-border-subtle bg-surface p-4">
          <h2 className="mb-1 flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
            <GitBranch size={14} strokeWidth={1.75} />
            Repositório
          </h2>
          <InfoRow label="URL" value={<span className="truncate">{project.repoUrl}</span>} />
          <InfoRow label="Linguagem" value={stack?.language ?? "—"} />
          <InfoRow label="Framework" value={stack?.framework ?? "—"} />
          <InfoRow label="Gerenciador de pacotes" value={stack?.packageManager ?? "—"} />
          <InfoRow
            label="Comando de start"
            value={<code className="font-mono text-[12px]">{stack?.startCommand ?? "—"}</code>}
          />
        </div>

        <div className="rounded-xl border border-border-subtle bg-surface p-4">
          <h2 className="mb-1 flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
            <ExternalLink size={14} strokeWidth={1.75} />
            Deploy
          </h2>
          <InfoRow
            label="URL pública"
            value={
              project.assignedPort ? (
                <a
                  href={`http://localhost:${project.assignedPort}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent hover:opacity-85"
                >
                  localhost:{project.assignedPort}
                </a>
              ) : (
                "—"
              )
            }
          />
          <InfoRow label="Container" value={<code className="font-mono text-[12px]">{project.containerName ?? "—"}</code>} />
          <InfoRow
            label="Criado em"
            value={new Date(project.createdAt).toLocaleString("pt-BR")}
          />
        </div>

        <DomainCard
          projectId={project.id}
          isDeployed={project.assignedPort != null}
          customDomain={project.customDomain}
          domainSslStatus={project.domainSslStatus}
        />
      </div>

      <h2 className="mb-2.5 mt-6 flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
        <Cpu size={14} strokeWidth={1.75} />
        Consumo de recursos
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border-subtle bg-surface p-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Cpu size={14} strokeWidth={1.75} />
            <span className="text-[12.5px] font-medium">CPU</span>
          </div>
          <p className="mt-2 font-mono text-[20px] font-semibold text-foreground">
            {container?.cpuPercent != null ? `${container.cpuPercent.toFixed(1)}%` : "—"}
          </p>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {project.status === "running" ? "processo ativo" : "projeto não está rodando"}
          </p>
        </div>

        <div className="rounded-xl border border-border-subtle bg-surface p-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <MemoryStick size={14} strokeWidth={1.75} />
            <span className="text-[12.5px] font-medium">Memória</span>
          </div>
          <p className="mt-2 font-mono text-[20px] font-semibold text-foreground">
            {container?.memUsageMb != null ? `${container.memUsageMb} MB` : "—"}
          </p>
          <p className="mt-1 text-[12px] text-muted-foreground">
            limite de {metrics ? CONTAINER_MEMORY_LIMIT_MB[metrics.tier] : "—"} MB nesse tier
          </p>
        </div>

        <div className="rounded-xl border border-border-subtle bg-surface p-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <HardDrive size={14} strokeWidth={1.75} />
            <span className="text-[12.5px] font-medium">Disco</span>
          </div>
          <p className="mt-2 font-mono text-[20px] font-semibold text-foreground">
            {diskUsageMb != null ? `${diskUsageMb} MB` : "—"}
          </p>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {metrics?.diskFreeGb != null
              ? `${metrics.diskFreeGb.toFixed(0)} GB livres no servidor`
              : "espaço livre indisponível"}
          </p>
        </div>
      </div>
    </div>
  );
}
