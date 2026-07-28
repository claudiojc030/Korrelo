import { Cpu, MemoryStick, HardDrive, Clock, Box } from "lucide-react";
import type { SystemMetrics } from "@forgedesk/shared-types";
import { MetricTile } from "./metric-tile";
import { GithubConnectButton } from "../../github-connect-button";
import { authHeaderServer } from "../../../lib/auth-cookie-server";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

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

async function getGithubStatus() {
  try {
    const res = await fetch(`${API_URL}/github/status`, {
      cache: "no-store",
      headers: authHeaderServer(),
    });
    if (!res.ok) return null;
    return res.json() as Promise<{ connected: boolean; accountLogin: string | null }>;
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

const TIER_LABEL: Record<SystemMetrics["tier"], string> = {
  nano: "Nano",
  micro: "Micro",
  small: "Small",
  medium: "Medium",
  large: "Large",
};

export default async function DashboardPage() {
  const [metrics, githubStatus] = await Promise.all([getSystemMetrics(), getGithubStatus()]);

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Dashboard</h1>
          <p className="mt-0.5 text-[13.5px] text-muted-foreground">
            Estado do servidor em tempo real.
          </p>
        </div>
        {metrics && (
          <span className="rounded-full border border-border-subtle bg-surface px-3 py-1 text-[12px] font-medium text-muted-foreground">
            Tier {TIER_LABEL[metrics.tier]}
          </span>
        )}
      </div>

      {!githubStatus?.connected && (
        <div className="mb-6 flex items-center justify-between rounded-xl border border-border-subtle bg-surface p-4">
          <div>
            <p className="text-[13.5px] font-medium text-foreground">Conecte sua conta do GitHub</p>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              Necessário pra importar e implantar seus repositórios.
            </p>
          </div>
          <GithubConnectButton />
        </div>
      )}

      {!metrics ? (
        <p className="text-[13.5px] text-destructive">
          Não foi possível carregar as métricas — verifique se a API está no ar.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <MetricTile label="CPU" icon={Cpu} percent={metrics.cpuPercent} detail="uso médio agora" />
            <MetricTile
              label="Memória"
              icon={MemoryStick}
              percent={metrics.usedMemPercent}
              detail={`${((metrics.totalMemMb - metrics.freeMemMb) / 1024).toFixed(1)} GB de ${(metrics.totalMemMb / 1024).toFixed(1)} GB`}
            />
            {metrics.usedDiskPercent !== null ? (
              <MetricTile
                label="Disco"
                icon={HardDrive}
                percent={metrics.usedDiskPercent}
                detail={`${((metrics.diskTotalGb ?? 0) - (metrics.diskFreeGb ?? 0)).toFixed(0)} GB de ${(metrics.diskTotalGb ?? 0).toFixed(0)} GB`}
              />
            ) : (
              <div className="rounded-xl border border-border-subtle bg-surface p-4">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <HardDrive size={15} strokeWidth={1.75} />
                  <span className="text-[13px] font-medium">Disco</span>
                </div>
                <p className="mt-3 text-[12.5px] text-muted-foreground">indisponível nesta plataforma</p>
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center gap-2 rounded-xl border border-border-subtle bg-surface px-4 py-3 text-[13px] text-muted-foreground">
            <Clock size={15} strokeWidth={1.75} />
            Uptime <span className="font-mono text-foreground">{formatUptime(metrics.uptimeSeconds)}</span>
          </div>

          <div className="mt-8">
            <div className="mb-2.5 flex items-center gap-2 text-muted-foreground">
              <Box size={15} strokeWidth={1.75} />
              <h2 className="text-[13px] font-medium">Containers Docker</h2>
            </div>
            {metrics.containers.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">Nenhum container rodando.</p>
            ) : (
              <div className="overflow-hidden rounded-xl border border-border-subtle bg-surface">
                {metrics.containers.map((container, i) => (
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
                      {container.memUsageMb !== null ? `${container.memUsageMb} MB` : "—"}
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
