import { Injectable } from "@nestjs/common";
import * as os from "node:os";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { classifyResourceTier, type ContainerSummary, type SystemMetrics } from "@korrelo/shared-types";
import type { SystemMetricsCollector } from "../domain/system-metrics-collector";

const execFile = promisify(execFileCallback);
const CPU_SAMPLE_WINDOW_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sumCpuTimes() {
  return os.cpus().reduce(
    (acc, cpu) => {
      acc.idle += cpu.times.idle;
      acc.total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
      return acc;
    },
    { idle: 0, total: 0 },
  );
}

async function getCpuPercent(): Promise<number> {
  const start = sumCpuTimes();
  await sleep(CPU_SAMPLE_WINDOW_MS);
  const end = sumCpuTimes();

  const idleDelta = end.idle - start.idle;
  const totalDelta = end.total - start.total;
  if (totalDelta <= 0) return 0;

  return Math.round((1 - idleDelta / totalDelta) * 100);
}

async function getDiskUsage(): Promise<{ totalGb: number | null; freeGb: number | null }> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFile("powershell", [
        "-NoProfile",
        "-Command",
        "(Get-PSDrive -Name (Get-Location).Drive.Name | Select-Object Used,Free | ConvertTo-Json)",
      ]);
      const data = JSON.parse(stdout) as { Used: number; Free: number };
      const totalBytes = data.Used + data.Free;
      return { totalGb: totalBytes / 1e9, freeGb: data.Free / 1e9 };
    }

    const { stdout } = await execFile("df", ["-k", "/"]);
    const lastLine = stdout.trim().split("\n").at(-1) ?? "";
    const parts = lastLine.split(/\s+/);
    const totalKb = Number(parts[1]);
    const availableKb = Number(parts[3]);
    if (!totalKb || Number.isNaN(availableKb)) return { totalGb: null, freeGb: null };
    return { totalGb: totalKb / 1e6, freeGb: availableKb / 1e6 };
  } catch {
    return { totalGb: null, freeGb: null };
  }
}

function parseMemUsageMb(memUsage: string): number | null {
  const match = memUsage.match(/^([\d.]+)\s*(KiB|MiB|GiB)/);
  if (!match) return null;

  const value = Number(match[1]);
  switch (match[2]) {
    case "GiB":
      return Math.round(value * 1024);
    case "KiB":
      return Math.round(value / 1024);
    default:
      return Math.round(value);
  }
}

async function getContainers(): Promise<ContainerSummary[]> {
  try {
    const { stdout } = await execFile("docker", ["ps", "--format", "{{.Names}}|{{.Status}}"]);
    const rows = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, status] = line.split("|");
        return { name, status };
      });

    if (rows.length === 0) return [];

    let memByName = new Map<string, number>();
    let cpuByName = new Map<string, number>();
    try {
      const { stdout: statsOut } = await execFile("docker", [
        "stats",
        "--no-stream",
        "--format",
        "{{.Name}}|{{.MemUsage}}|{{.CPUPerc}}",
      ]);
      const lines = statsOut.trim().split("\n").filter(Boolean);
      memByName = new Map(
        lines
          .map((line) => {
            const [name, memUsage] = line.split("|");
            return [name, parseMemUsageMb(memUsage)] as const;
          })
          .filter((entry): entry is [string, number] => entry[1] !== null),
      );
      cpuByName = new Map(
        lines
          .map((line) => {
            const [name, , cpuPerc] = line.split("|");
            const value = Number(cpuPerc?.replace("%", ""));
            return [name, value] as const;
          })
          .filter((entry): entry is [string, number] => !Number.isNaN(entry[1])),
      );
    } catch {
      // docker stats pode ser lento/instável; degrada sem quebrar o dashboard inteiro.
    }

    return rows.map((row) => ({
      name: row.name,
      status: row.status,
      memUsageMb: memByName.get(row.name) ?? null,
      cpuPercent: cpuByName.get(row.name) ?? null,
    }));
  } catch {
    return [];
  }
}

@Injectable()
export class OsSystemMetricsCollector implements SystemMetricsCollector {
  async collect(): Promise<SystemMetrics> {
    const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
    const freeMemMb = Math.round(os.freemem() / 1024 / 1024);

    const [cpuPercent, disk, containers] = await Promise.all([
      getCpuPercent(),
      getDiskUsage(),
      getContainers(),
    ]);

    return {
      cpuPercent,
      totalMemMb,
      freeMemMb,
      usedMemPercent: Math.round(((totalMemMb - freeMemMb) / totalMemMb) * 100),
      diskTotalGb: disk.totalGb,
      diskFreeGb: disk.freeGb,
      usedDiskPercent:
        disk.totalGb && disk.freeGb !== null
          ? Math.round(((disk.totalGb - disk.freeGb) / disk.totalGb) * 100)
          : null,
      uptimeSeconds: Math.round(os.uptime()),
      tier: classifyResourceTier(totalMemMb),
      containers,
    };
  }
}
