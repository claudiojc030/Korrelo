import Link from "next/link";
import { Cpu, MemoryStick, HardDrive, Clock, Box, Server, ExternalLink, SquareTerminal } from "lucide-react";
import { CONTAINER_MEMORY_LIMIT_MB, type ContainerSummary, type Project, type SystemMetrics } from "@korrelo/shared-types";
import { MetricTile } from "./metric-tile";
import { MetricsHistoryChart } from "./metrics-history-chart";
import { OnboardingChecklist } from "./onboarding-checklist";
import { UpdateBanner } from "./update-banner";
import { TierBadge } from "./tier-badge";
import { authHeaderServer } from "../../../lib/auth-cookie-server";
import { AutoRefresh } from "../../../components/auto-refresh";
import { getLocaleServer } from "../../../lib/i18n/get-locale-server";
import { getDictionary } from "../../../lib/i18n/dictionaries";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

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

async function getProjects(): Promise<Project[]> {
  try {
    const res = await fetch(`${API_URL}/projects`, { cache: "no-store", headers: await authHeaderServer() });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

async function getGithubStatus() {
  try {
    const res = await fetch(`${API_URL}/github/status`, {
      cache: "no-store",
      headers: await authHeaderServer(),
    });
    if (!res.ok) return null;
    return res.json() as Promise<{ connected: boolean; accountLogin: string | null }>;
  } catch {
    return null;
  }
}

async function getTwoFactorStatus(): Promise<{ enabled: boolean } | null> {
  try {
    const res = await fetch(`${API_URL}/auth/2fa/status`, {
      cache: "no-store",
      headers: await authHeaderServer(),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

interface UpdateStatus {
  checked: boolean;
  currentCommit: string | null;
  remoteCommit: string | null;
  commitsBehind: number;
  updateAvailable: boolean;
}

async function getUpdateStatus(): Promise<UpdateStatus | null> {
  try {
    const res = await fetch(`${API_URL}/monitoring/update-status`, {
      cache: "no-store",
      headers: await authHeaderServer(),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}min`;
  return `${minutes}min`;
}

export default async function DashboardPage() {
  const t = getDictionary(await getLocaleServer());
  const TIER_LABEL: Record<SystemMetrics["tier"], string> = {
    nano: t.dashboard.tierNano,
    micro: t.dashboard.tierMicro,
    small: t.dashboard.tierSmall,
    medium: t.dashboard.tierMedium,
    large: t.dashboard.tierLarge,
  };
  const [metrics, projects, githubStatus, twoFactorStatus, updateStatus] = await Promise.all([
    getSystemMetrics(),
    getProjects(),
    getGithubStatus(),
    getTwoFactorStatus(),
    getUpdateStatus(),
  ]);

  const runningProjects = projects.filter((p) => p.status === "running" && p.containerName);
  const projectContainerNames = new Set(runningProjects.map((p) => p.containerName));
  const otherContainers = metrics?.containers.filter((c) => !projectContainerNames.has(c.name)) ?? [];
  const memLimitMb = metrics ? CONTAINER_MEMORY_LIMIT_MB[metrics.tier] : null;

  function findContainer(name: string | null): ContainerSummary | undefined {
    return metrics?.containers.find((c) => c.name === name);
  }

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <AutoRefresh intervalMs={12000} />
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t.dashboard.title}</h1>
          <p className="mt-0.5 flex items-center gap-1.5 text-[13.5px] text-muted-foreground">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
            </span>
            {t.dashboard.autoRefreshNote}
          </p>
        </div>
        {metrics && <TierBadge tier={metrics.tier} label={TIER_LABEL[metrics.tier]} />}
      </div>

      {updateStatus && <UpdateBanner status={updateStatus} />}

      <OnboardingChecklist
        githubConnected={githubStatus?.connected ?? false}
        hasProjects={projects.length > 0}
        twoFactorEnabled={twoFactorStatus?.enabled ?? false}
      />

      {!metrics ? (
        <p className="text-[13.5px] text-destructive">{t.dashboard.metricsUnavailable}</p>
      ) : (
        <>
          <h2 className="mb-2.5 text-[13px] font-medium text-muted-foreground">
            {t.dashboard.overview} <span className="text-muted-foreground/60">· {t.dashboard.overviewSubtitle}</span>
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <MetricTile label={t.dashboard.cpu} icon={Cpu} percent={metrics.cpuPercent} detail={t.dashboard.cpuDetail} />
            <MetricTile
              label={t.dashboard.memory}
              icon={MemoryStick}
              percent={metrics.usedMemPercent}
              detail={`${((metrics.totalMemMb - metrics.freeMemMb) / 1024).toFixed(1)} GB ${t.dashboard.memoryOf} ${(metrics.totalMemMb / 1024).toFixed(1)} GB`}
            />
            {metrics.usedDiskPercent !== null ? (
              <MetricTile
                label={t.dashboard.disk}
                icon={HardDrive}
                percent={metrics.usedDiskPercent}
                detail={`${((metrics.diskTotalGb ?? 0) - (metrics.diskFreeGb ?? 0)).toFixed(0)} GB ${t.dashboard.memoryOf} ${(metrics.diskTotalGb ?? 0).toFixed(0)} GB`}
              />
            ) : (
              <div className="rounded-xl border border-border-subtle bg-surface p-4">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <HardDrive size={15} strokeWidth={1.75} />
                  <span className="text-[13px] font-medium">{t.dashboard.disk}</span>
                </div>
                <p className="mt-3 text-[12.5px] text-muted-foreground">{t.common.unavailableOnPlatform}</p>
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center gap-2 rounded-xl border border-border-subtle bg-surface px-4 py-3 text-[13px] text-muted-foreground">
            <Clock size={15} strokeWidth={1.75} />
            {t.dashboard.uptime} <span className="font-mono text-foreground">{formatUptime(metrics.uptimeSeconds)}</span>
          </div>

          <MetricsHistoryChart />

          <div className="mt-8">
            <div className="mb-2.5 flex items-center gap-2 text-muted-foreground">
              <Server size={15} strokeWidth={1.75} />
              <h2 className="text-[13px] font-medium">
                {t.dashboard.runningProjects} <span className="text-muted-foreground/60">· {t.dashboard.runningProjectsSubtitle}</span>
              </h2>
            </div>

            {runningProjects.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">{t.dashboard.noRunningProjects}</p>
            ) : (
              <div className="overflow-hidden rounded-xl border border-border-subtle bg-surface">
                {runningProjects.map((project, i) => {
                  const container = findContainer(project.containerName);
                  const memPercent =
                    container?.memUsageMb != null && memLimitMb
                      ? Math.min(Math.round((container.memUsageMb / memLimitMb) * 100), 100)
                      : null;

                  return (
                    <div
                      key={project.id}
                      className={`flex items-center justify-between gap-4 px-4 py-3 ${
                        i > 0 ? "border-t border-border-subtle" : ""
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="h-1.5 w-1.5 flex-none rounded-full bg-accent" />
                          <p className="truncate text-[13.5px] font-medium text-foreground">{project.name}</p>
                        </div>
                        <div className="mt-1 flex items-center gap-3 pl-3.5">
                          {project.assignedPort && (
                            <a
                              href={`http://localhost:${project.assignedPort}`}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-[12px] text-accent hover:opacity-85"
                            >
                              <ExternalLink size={11} strokeWidth={1.75} />
                              localhost:{project.assignedPort}
                            </a>
                          )}
                          <Link
                            href={`/projects/${project.id}/terminal`}
                            className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
                          >
                            <SquareTerminal size={11} strokeWidth={1.75} />
                            {t.dashboard.terminal}
                          </Link>
                        </div>
                      </div>

                      <div className="flex flex-none items-center gap-5 font-mono text-[12.5px] text-muted-foreground">
                        <div className="flex flex-col items-end gap-1">
                          <span>CPU {container?.cpuPercent != null ? `${container.cpuPercent.toFixed(1)}%` : "-"}</span>
                        </div>
                        <div className="flex w-28 flex-col items-end gap-1">
                          <span>
                            {container?.memUsageMb != null ? `${container.memUsageMb} MB` : "-"}
                            {memLimitMb && <span className="text-muted-foreground/60"> / {memLimitMb} MB</span>}
                          </span>
                          {memPercent !== null && (
                            <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-accent"
                                style={{ width: `${memPercent}%` }}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-8">
            <div className="mb-2.5 flex items-center gap-2 text-muted-foreground">
              <Box size={15} strokeWidth={1.75} />
              <h2 className="text-[13px] font-medium">
                {t.dashboard.infrastructure} <span className="text-muted-foreground/60">· {t.dashboard.infrastructureSubtitle}</span>
              </h2>
            </div>
            {otherContainers.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">{t.dashboard.noInfraContainers}</p>
            ) : (
              <div className="overflow-hidden rounded-xl border border-border-subtle bg-surface">
                {otherContainers.map((container, i) => (
                  <div
                    key={container.name}
                    className={`flex items-center justify-between px-4 py-3 ${
                      i > 0 ? "border-t border-border-subtle" : ""
                    }`}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[13.5px] text-foreground">{container.name}</p>
                      <p className="mt-0.5 text-[12px] text-muted-foreground">{container.status}</p>
                    </div>
                    <span className="flex-none font-mono text-[12.5px] text-muted-foreground">
                      {container.cpuPercent != null ? `${container.cpuPercent.toFixed(1)}% · ` : ""}
                      {container.memUsageMb !== null ? `${container.memUsageMb} MB` : "-"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
