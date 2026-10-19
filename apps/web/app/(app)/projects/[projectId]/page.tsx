import { ExternalLink, GitBranch, Cpu, MemoryStick, HardDrive, History, Globe } from "lucide-react";
import type { DetectedStack, Project, SystemMetrics } from "@korrelo/shared-types";
import { authHeaderServer } from "../../../../lib/auth-cookie-server";
import { getRequestHostServer } from "../../../../lib/get-request-host-server";
import { DomainCard } from "./domain-card";
import { DeployButton } from "../deploy-button";
import { DeployHistory } from "./deploy-history";
import { getProjectPublicUrl } from "../../../../lib/project-public-url";
import { getLocaleServer } from "../../../../lib/i18n/get-locale-server";
import { getDictionary } from "../../../../lib/i18n/dictionaries";
import { fetchApiServer, type ApiServerResult } from "../../../../lib/api-server-fetch";

/**
 * Cada chamada do backend tem TIMEOUT próprio: uma delas travar (Docker
 * lento, API sobrecarregada) não pode derrubar o render da página inteira.
 * O que falhou simplesmente vem como null e a tela mostra o estado parcial.
 */
async function getProject(projectId: string): Promise<ApiServerResult<Project>> {
  return fetchApiServer<Project>(`/projects/${projectId}`, { headers: await authHeaderServer() });
}

async function getDiskUsage(projectId: string): Promise<ApiServerResult<{ diskUsageMb: number }>> {
  return fetchApiServer<{ diskUsageMb: number }>(`/projects/${projectId}/disk-usage`, {
    headers: await authHeaderServer(),
  });
}

interface DeployRecord {
  id: string;
  status: "running" | "success" | "failed";
  triggeredBy: "manual" | "webhook";
  errorMessage: string | null;
  log: string;
  commitHash: string | null;
  commitMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

async function getDeployRecords(projectId: string): Promise<ApiServerResult<DeployRecord[]>> {
  return fetchApiServer<DeployRecord[]>(`/projects/${projectId}/deploys`, { headers: await authHeaderServer() });
}

async function getDomainAliases(projectId: string): Promise<ApiServerResult<string[]>> {
  return fetchApiServer<string[]>(`/projects/${projectId}/domain/aliases`, { headers: await authHeaderServer() });
}

async function getSystemMetrics(): Promise<ApiServerResult<SystemMetrics>> {
  return fetchApiServer<SystemMetrics>("/monitoring/system", { headers: await authHeaderServer() });
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
  const host = await getRequestHostServer();
  const [projectResult, diskUsageResult, metricsResult, deployRecordsResult, domainAliasesResult] = await Promise.all([
    getProject(params.projectId),
    getDiskUsage(params.projectId),
    getSystemMetrics(),
    getDeployRecords(params.projectId),
    getDomainAliases(params.projectId),
  ]);

  if (!projectResult.ok) {
    // Antes, qualquer falha (inclusive timeout) devolvia null e a página
    // ficava em branco, sem dizer o que aconteceu.
    return (
      <div className="mx-auto max-w-5xl px-8 py-10">
        <p className="text-[13.5px] text-destructive">{t.projectDetail.projectLoadError}</p>
      </div>
    );
  }

  const project = projectResult.data;
  const diskUsageMb = diskUsageResult.ok ? diskUsageResult.data.diskUsageMb : null;
  const metrics = metricsResult.ok ? metricsResult.data : null;
  const deployRecords = deployRecordsResult.ok ? deployRecordsResult.data : [];
  const domainAliases = domainAliasesResult.ok ? domainAliasesResult.data : [];

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
              (() => {
                const url = getProjectPublicUrl(project, host);
                return url ? (
                  <a href={url.href} target="_blank" rel="noreferrer" className="text-accent hover:opacity-85">
                    {url.label}
                  </a>
                ) : (
                  "-"
                );
              })()
            }
          />
          <InfoRow label={t.projectDetail.container} value={<code className="font-mono text-[12px]">{project.containerName ?? "-"}</code>} />
          <InfoRow
            label={t.projectDetail.createdAt}
            value={new Date(project.createdAt).toLocaleString("pt-BR")}
          />
          <div className="mt-3 border-t border-border-subtle pt-3">
            <DeployButton projectId={project.id} />
          </div>
        </div>

        <DomainCard
          projectId={project.id}
          isDeployed={project.assignedPort != null}
          customDomain={project.customDomain}
          domainSslStatus={project.domainSslStatus}
          initialAliases={domainAliases}
        />

        <div className="rounded-xl border border-border-subtle bg-surface p-4">
          <h2 className="mb-2 flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
            <Globe size={14} strokeWidth={1.75} />
            {t.projectDetail.domainHelpTitle}
          </h2>
          <ol className="flex flex-col gap-2.5 text-[12.5px] text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">1.</span> {t.projectDetail.domainHelpStep1}
            </li>
            <li>
              <span className="font-medium text-foreground">2.</span> {t.projectDetail.domainHelpStep2}{" "}
              <code className="rounded bg-background px-1.5 py-0.5 font-mono text-accent">{host.split(":")[0]}</code>
            </li>
            <li>
              <span className="font-medium text-foreground">3.</span> {t.projectDetail.domainHelpStep3}
            </li>
            <li>
              <span className="font-medium text-foreground">4.</span> {t.projectDetail.domainHelpStep4}
            </li>
          </ol>
        </div>
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
              String(container?.memLimitMb ?? "-"),
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
      <DeployHistory projectId={project.id} initialRecords={deployRecords} />
    </div>
  );
}
