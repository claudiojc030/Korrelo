import { Injectable, Logger } from "@nestjs/common";
import * as os from "node:os";
import { classifyResourceTier, type ContainerSummary, type SystemMetrics } from "@korrelo/shared-types";
import type { SystemMetricsCollector } from "../domain/system-metrics-collector";
import { runCommand, type RunCommandResult } from "../../../infrastructure/command-runner";

const CPU_SAMPLE_WINDOW_MS = 300;

/**
 * Tempos limite de cada comando externo. Configuráveis por variável de
 * ambiente porque o tempo aceitável depende da VPS (e o valor errado aqui
 * foi exatamente o que travou o painel no incidente de 19/10/2026).
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DOCKER_LIST_TIMEOUT_MS = envInt("SYSTEM_METRICS_DOCKER_TIMEOUT_MS", 4_000);
const DOCKER_STATS_TIMEOUT_MS = envInt("SYSTEM_METRICS_DOCKER_STATS_TIMEOUT_MS", 6_000);
const DISK_TIMEOUT_MS = envInt("SYSTEM_METRICS_DISK_TIMEOUT_MS", 5_000);

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

/** Descrição curta do motivo de uma falha de comando (sem vazar dados sensíveis). */
function describeFailure(result: RunCommandResult): string {
  if (result.timedOut) return "timeout";
  if (result.truncated) return "saída truncada";
  if (result.signal) return `encerrado por ${result.signal}`;
  if (result.exitCode !== null && result.exitCode !== 0) return `exit code ${result.exitCode}`;
  return "erro desconhecido";
}

async function getDiskUsage(): Promise<{ totalGb: number | null; freeGb: number | null }> {
  try {
    if (process.platform === "win32") {
      const result = await runCommand(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "(Get-PSDrive -Name (Get-Location).Drive.Name | Select-Object Used,Free | ConvertTo-Json)",
        ],
        { timeoutMs: DISK_TIMEOUT_MS },
      );
      if (result.timedOut || result.exitCode !== 0) {
        return { totalGb: null, freeGb: null };
      }
      const data = JSON.parse(result.stdout) as { Used: number; Free: number };
      const totalBytes = data.Used + data.Free;
      return { totalGb: totalBytes / 1e9, freeGb: data.Free / 1e9 };
    }

    const result = await runCommand("df", ["-k", "/"], { timeoutMs: DISK_TIMEOUT_MS });
    if (result.timedOut || result.exitCode !== 0) {
      return { totalGb: null, freeGb: null };
    }
    const lastLine = result.stdout.trim().split("\n").at(-1) ?? "";
    const parts = lastLine.split(/\s+/);
    const totalKb = Number(parts[1]);
    const availableKb = Number(parts[3]);
    if (!totalKb || Number.isNaN(availableKb)) return { totalGb: null, freeGb: null };
    return { totalGb: totalKb / 1e6, freeGb: availableKb / 1e6 };
  } catch {
    return { totalGb: null, freeGb: null };
  }
}

// "{{.MemUsage}}" do docker stats vem como "393.2MiB / 512MiB" - usado E o
// limite real do cgroup na mesma string, então dá pra extrair os dois de uma
// vez em vez de fixar o limite por tier (que não reflete a divisão dinâmica
// de RAM entre projetos rodando ao mesmo tempo).
function parseMemUsage(memUsage: string): { usedMb: number | null; limitMb: number | null } {
  const [usedPart, limitPart] = memUsage.split("/");
  return {
    usedMb: usedPart ? parseMemAmountMb(usedPart.trim()) : null,
    limitMb: limitPart ? parseMemAmountMb(limitPart.trim()) : null,
  };
}

function parseMemAmountMb(amount: string): number | null {
  const match = amount.match(/^([\d.]+)\s*(KiB|MiB|GiB)/);
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

interface ContainersResult {
  containers: ContainerSummary[];
  /** false quando o Docker não respondeu (timeout, erro ou binário ausente). */
  dockerReachable: boolean;
}

async function getContainers(logger: Logger): Promise<ContainersResult> {
  // "docker ps" e "docker stats" rodam EM PARALELO: são independentes e o
  // tempo total da coleta fica preso ao maior timeout, não à soma. Isso
  // importa porque a página do dashboard tem timeout de poucos segundos.
  const listPromise = runCommand("docker", ["ps", "--format", "{{.Names}}|{{.Status}}"], {
    timeoutMs: DOCKER_LIST_TIMEOUT_MS,
  }).catch((error) => {
    logger.warn(`[metrics] "docker ps" indisponível: ${(error as Error).message}`);
    return null;
  });

  const statsPromise = runCommand(
    "docker",
    ["stats", "--no-stream", "--format", "{{.Name}}|{{.MemUsage}}|{{.CPUPerc}}"],
    { timeoutMs: DOCKER_STATS_TIMEOUT_MS },
  ).catch((error) => {
    logger.warn(`[metrics] "docker stats" indisponível: ${(error as Error).message}`);
    return null;
  });

  const [listResult, statsResult] = await Promise.all([listPromise, statsPromise]);

  if (!listResult || listResult.timedOut || listResult.exitCode !== 0) {
    if (listResult) {
      logger.warn(`[metrics] "docker ps" falhou (${describeFailure(listResult)}) - métricas de container indisponíveis`);
    }
    return { containers: [], dockerReachable: false };
  }

  const rows = listResult.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, status] = line.split("|");
      return { name, status };
    });

  let memByName = new Map<string, number>();
  let memLimitByName = new Map<string, number>();
  let cpuByName = new Map<string, number>();
  let dockerReachable = true;

  if (!statsResult || statsResult.timedOut || statsResult.exitCode !== 0) {
    // "docker ps" respondeu, mas "docker stats" não: o daemon está sob
    // pressão. A lista de containers continua válida, só os números de
    // memória/CPU não puderam ser lidos.
    dockerReachable = false;
    if (statsResult) {
      logger.warn(
        `[metrics] "docker stats" falhou (${describeFailure(statsResult)}) - memória/CPU dos containers indisponíveis`,
      );
    }
  } else {
    const lines = statsResult.stdout.trim().split("\n").filter(Boolean);
    const parsed = lines.map((line) => {
      const [name, memUsage] = line.split("|");
      return { name, ...parseMemUsage(memUsage) };
    });
    memByName = new Map(
      parsed
        .filter((entry): entry is typeof entry & { usedMb: number } => entry.usedMb !== null)
        .map((entry) => [entry.name, entry.usedMb]),
    );
    memLimitByName = new Map(
      parsed
        .filter((entry): entry is typeof entry & { limitMb: number } => entry.limitMb !== null)
        .map((entry) => [entry.name, entry.limitMb]),
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
  }

  return {
    containers: rows.map((row) => ({
      name: row.name,
      status: row.status,
      memUsageMb: memByName.get(row.name) ?? null,
      memLimitMb: memLimitByName.get(row.name) ?? null,
      cpuPercent: cpuByName.get(row.name) ?? null,
    })),
    dockerReachable,
  };
}

@Injectable()
export class OsSystemMetricsCollector implements SystemMetricsCollector {
  private readonly logger = new Logger(OsSystemMetricsCollector.name);

  async collect(): Promise<SystemMetrics> {
    const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
    const freeMemMb = Math.round(os.freemem() / 1024 / 1024);

    const [cpuPercent, disk, containerResult] = await Promise.all([
      getCpuPercent(),
      getDiskUsage(),
      getContainers(this.logger),
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
      containers: containerResult.containers,
      // Sinaliza explicitamente que o Docker não respondeu, pra frente não
      // interpretar "sem containers" como "nenhum container rodando".
      dockerReachable: containerResult.dockerReachable,
      collectedAt: new Date().toISOString(),
    };
  }
}
