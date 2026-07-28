import type { SystemMetrics } from "@forgedesk/shared-types";
import { MetricTile } from "./metric-tile";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

async function getSystemMetrics(): Promise<SystemMetrics | null> {
  try {
    const res = await fetch(`${API_URL}/monitoring/system`, { cache: "no-store" });
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

const TIER_LABEL: Record<SystemMetrics["tier"], string> = {
  nano: "Nano",
  micro: "Micro",
  small: "Small",
  medium: "Medium",
  large: "Large",
};

export default async function DashboardPage() {
  const metrics = await getSystemMetrics();

  if (!metrics) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-2">
        <p className="text-red-400">Não foi possível carregar as métricas (API offline?)</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center gap-8 px-4 py-16">
      <div className="flex w-full max-w-3xl items-center justify-between">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <span className="rounded-full border border-neutral-700 px-3 py-1 text-xs text-neutral-400">
          Tier {TIER_LABEL[metrics.tier]}
        </span>
      </div>

      <div className="grid w-full max-w-3xl grid-cols-1 gap-3 sm:grid-cols-3">
        <MetricTile
          label="CPU"
          percent={metrics.cpuPercent}
          detail="uso médio nos últimos instantes"
        />
        <MetricTile
          label="Memória"
          percent={metrics.usedMemPercent}
          detail={`${((metrics.totalMemMb - metrics.freeMemMb) / 1024).toFixed(1)} GB de ${(metrics.totalMemMb / 1024).toFixed(1)} GB`}
        />
        {metrics.usedDiskPercent !== null ? (
          <MetricTile
            label="Disco"
            percent={metrics.usedDiskPercent}
            detail={`${((metrics.diskTotalGb ?? 0) - (metrics.diskFreeGb ?? 0)).toFixed(0)} GB de ${(metrics.diskTotalGb ?? 0).toFixed(0)} GB`}
          />
        ) : (
          <div className="rounded-md border border-neutral-800 px-4 py-3">
            <span className="text-sm text-neutral-400">Disco</span>
            <p className="mt-1 text-sm text-neutral-500">indisponível nesta plataforma</p>
          </div>
        )}
      </div>

      <div className="w-full max-w-3xl rounded-md border border-neutral-800 px-4 py-3 text-sm text-neutral-400">
        Uptime: <span className="text-neutral-200">{formatUptime(metrics.uptimeSeconds)}</span>
      </div>

      <div className="w-full max-w-3xl">
        <h2 className="mb-2 text-sm text-neutral-400">Containers Docker</h2>
        {metrics.containers.length === 0 ? (
          <p className="text-sm text-neutral-500">Nenhum container rodando.</p>
        ) : (
          <ul className="divide-y divide-neutral-800 rounded-md border border-neutral-800">
            {metrics.containers.map((container) => (
              <li key={container.name} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-sm">{container.name}</p>
                  <p className="text-xs text-neutral-500">{container.status}</p>
                </div>
                <span className="text-sm text-neutral-400">
                  {container.memUsageMb !== null ? `${container.memUsageMb} MB` : "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
