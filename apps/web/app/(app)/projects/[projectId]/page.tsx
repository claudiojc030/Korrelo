import { ExternalLink, GitBranch, Cpu, MemoryStick, HardDrive, History, Webhook, MousePointerClick } from "lucide-react";
import { CONTAINER_MEMORY_LIMIT_MB, type DetectedStack, type Project, type SystemMetrics } from "@korrelo/shared-types";
import { authHeaderServer } from "../../../../lib/auth-cookie-server";
import { DomainCard } from "./domain-card";
import { getLocaleServer } from "../../../../lib/i18n/get-locale-server";
import { getDictionary } from "../../../../lib/i18n/dictionaries";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

async function getProject(projectId: string): Promise<Project | null> {
  try {
    const res = await fetch(`${API_URL}/projects/${projectId}`, {
      cache: "no-store",
      headers: await authHeaderServer(),
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
      headers: await authHeaderServer(),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { diskUsageMb: number };
    return data.diskUsageMb;
  } catch {
    return null;
  }
}

interface DeployRecord {
  id: string;
  status: "running" | "success" | "failed";
  triggeredBy: "manual" | "webhook";
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

async function getDeployRecords(projectId: string): Promise<DeployRecord[]> {
  try {
    const res = await fetch(`${API_URL}/projects/${projectId}/deploys`, {
      cache: "no-store",
      headers: await authHeaderServer(),
    });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

async function getSystemMetrics(): Promise<SystemMetrics | null> {
  try {
    const res = await fetch(`${API_URL}/monitoring/system`, {
      cache: "no-store",
      headers: await authHeaderServer(),
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

export default async function ProjectSummaryPage(props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  const t = getDictionary(await getLocaleServer());
  const [project, diskUsageMb, metrics, deployRecords] = await Promise.all([
    getProject(params.projectId),
    getDiskUsage(params.projectId),
    getSystemMetrics(),
    getDeployRecords(params.projectId),
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
            {t.projectDetail.repository}
          </h2>
          <InfoRow label={t.projectDetail.urlLabel} value={<span className="truncate">{project.repoUrl}</span>} />
          <InfoRow label={t.projectDetail.language} value={stack?.language ?? "-"} />
          <InfoRow label={t.projectDetail.framework} value={stack?.framework ?? "-"} />
          <InfoRow label={t.projectDetail.packageManager} value={stack?.packageManager ?? "-"} />
          <InfoRow
            label={t.projectDetail.startCommand}
            value={<code className="font-mono text-[12px]">{stack?.startCommand ?? "-"}</code>}
          />
        </div>

        <div className="rounded-xl border border-border-subtle bg-surface p-4">
          <h2 className="mb-1 flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
            <ExternalLink size={14} strokeWidth={1.75} />
            {t.projectDetail.deploy}
          </h2>
          <InfoRow
            label={t.projectDetail.publicUrl}
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
                "-"
              )
            }
          />
          <InfoRow label={t.projectDetail.container} value={<code className="font-mono text-[12px]">{project.containerName ?? "-"}</code>} />
          <InfoRow
            label={t.projectDetail.createdAt}
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
        {t.projectDetail.resourceUsage}
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border-subtle bg-surface p-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Cpu size={14} strokeWidth={1.75} />
            <span className="text-[12.5px] font-medium">{t.projectDetail.cpu}</span>
          </div>
          <p className="mt-2 font-mono text-[20px] font-semibold text-foreground">
            {container?.cpuPercent != null ? `${container.cpuPercent.toFixed(1)}%` : "-"}
          </p>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {project.status === "running" ? t.projectDetail.processActive : t.projectDetail.projectNotRunning}
          </p>
        </div>

        <div className="rounded-xl border border-border-subtle bg-surface p-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <MemoryStick size={14} strokeWidth={1.75} />
            <span className="text-[12.5px] font-medium">{t.projectDetail.memory}</span>
          </div>
          <p className="mt-2 font-mono text-[20px] font-semibold text-foreground">
            {container?.memUsageMb != null ? `${container.memUsageMb} MB` : "-"}
          </p>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {t.projectDetail.memoryLimitDetail.replace(
              "{limit}",
              String(metrics ? CONTAINER_MEMORY_LIMIT_MB[metrics.tier] : "-"),
            )}
          </p>
        </div>

        <div className="rounded-xl border border-border-subtle bg-surface p-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <HardDrive size={14} strokeWidth={1.75} />
            <span className="text-[12.5px] font-medium">{t.projectDetail.disk}</span>
          </div>
          <p className="mt-2 font-mono text-[20px] font-semibold text-foreground">
            {diskUsageMb != null ? `${diskUsageMb} MB` : "-"}
          </p>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {metrics?.diskFreeGb != null
              ? t.projectDetail.diskFreeDetail.replace("{free}", metrics.diskFreeGb.toFixed(0))
              : t.projectDetail.diskSpaceUnavailable}
          </p>
        </div>
      </div>

      <h2 className="mb-2.5 mt-6 flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
        <History size={14} strokeWidth={1.75} />
        {t.projectDetail.deployHistory}
      </h2>
      {deployRecords.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t.projectDetail.noDeploysYet}</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border-subtle bg-surface">
          {deployRecords.map((record) => {
            const statusStyle =
              record.status === "success"
                ? "text-accent"
                : record.status === "failed"
                  ? "text-destructive"
                  : "text-warning";
            const statusLabel =
              record.status === "success"
                ? t.projectDetail.deployStatusSuccess
                : record.status === "failed"
                  ? t.projectDetail.deployStatusFailed
                  : t.projectDetail.deployStatusInProgress;
            const durationMs = record.finishedAt
              ? new Date(record.finishedAt).getTime() - new Date(record.startedAt).getTime()
              : null;

            return (
              <div
                key={record.id}
                className="flex items-center justify-between gap-4 border-b border-border-subtle px-4 py-3 last:border-0"
              >
                <div className="flex items-center gap-2.5">
                  {record.triggeredBy === "webhook" ? (
                    <Webhook size={13} strokeWidth={1.75} className="flex-none text-muted-foreground" />
                  ) : (
                    <MousePointerClick size={13} strokeWidth={1.75} className="flex-none text-muted-foreground" />
                  )}
                  <div>
                    <p className="text-[13px] text-foreground">
                      {new Date(record.startedAt).toLocaleString("pt-BR")}
                      <span className="ml-2 text-[11.5px] text-muted-foreground">
                        {record.triggeredBy === "webhook" ? t.projectDetail.triggeredByWebhook : t.projectDetail.triggeredByManual}
                      </span>
                    </p>
                    {record.errorMessage && (
                      <p className="mt-0.5 max-w-md truncate text-[12px] text-destructive">{record.errorMessage}</p>
                    )}
                  </div>
                </div>
                <div className="flex flex-none items-center gap-3 text-[12.5px]">
                  {durationMs != null && (
                    <span className="text-muted-foreground">{Math.round(durationMs / 1000)}s</span>
                  )}
                  <span className={`font-medium ${statusStyle}`}>{statusLabel}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
