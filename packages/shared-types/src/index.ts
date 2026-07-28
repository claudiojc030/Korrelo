export type ProjectStatus = "detected" | "configuring" | "running" | "stopped" | "failed";

export interface Project {
  id: string;
  name: string;
  repoUrl: string;
  detectedStack: string | null;
  status: ProjectStatus;
  assignedPort: number | null;
  containerName: string | null;
  terminalEnabled: boolean;
  databaseEnabled: boolean;
  createdAt: string;
}

export interface DetectedStack {
  language: string;
  framework: string | null;
  packageManager: string | null;
  recommendedPort: number | null;
  startCommand: string | null;
  buildCommand: string | null;
}

export interface GithubRepositorySummary {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
}

export type ResourceTier = "nano" | "micro" | "small" | "medium" | "large";

export interface HardwareProfile {
  vCpus: number;
  totalMemMb: number;
  freeMemMb: number;
  platform: string;
  tier: ResourceTier;
}

const TIER_THRESHOLDS_MB: Array<{ tier: ResourceTier; maxMemMb: number }> = [
  { tier: "nano", maxMemMb: 1024 },
  { tier: "micro", maxMemMb: 4096 },
  { tier: "small", maxMemMb: 8192 },
  { tier: "medium", maxMemMb: 16384 },
  { tier: "large", maxMemMb: Infinity },
];

export function classifyResourceTier(totalMemMb: number): ResourceTier {
  const match = TIER_THRESHOLDS_MB.find((t) => totalMemMb <= t.maxMemMb);
  return match ? match.tier : "large";
}

// Teto de memória por container de projeto implantado pelo ForgeDesk, por tier de VPS.
// Conservador de propósito: numa VPS de 1-2GB, vários projetos rodando ao mesmo tempo
// não podem, juntos, estourar a RAM da máquina.
export const CONTAINER_MEMORY_LIMIT_MB: Record<ResourceTier, number> = {
  nano: 256,
  micro: 512,
  small: 768,
  medium: 1024,
  large: 2048,
};

export interface ContainerSummary {
  name: string;
  status: string;
  memUsageMb: number | null;
  cpuPercent: number | null;
}

export interface SystemMetrics {
  cpuPercent: number;
  totalMemMb: number;
  freeMemMb: number;
  usedMemPercent: number;
  diskTotalGb: number | null;
  diskFreeGb: number | null;
  usedDiskPercent: number | null;
  uptimeSeconds: number;
  tier: ResourceTier;
  containers: ContainerSummary[];
}
