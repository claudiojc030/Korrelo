export type ProjectStatus = "detected" | "configuring" | "running" | "stopped" | "failed";
export type DomainSslStatus = "none" | "pending" | "active" | "failed";

/**
 * Estado do ÚLTIMO deploy - separado do `status`, que é o estado de RUNTIME
 * da aplicação. Um deploy falho não derruba a aplicação em produção.
 */
export type LastDeployStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "rolled-back"
  | "canceled"
  | "interrupted";

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
  customDomain: string | null;
  domainSslStatus: DomainSslStatus;
  autoDeployEnabled: boolean;
  deployBranch: string;
  diskLimitMb: number | null;
  skipStagingTest: boolean;
  memoryLimitMb: number | null;
  /** Estado do último deploy (independente do estado da aplicação). */
  lastDeployStatus?: LastDeployStatus | null;
  /** Imagem em produção (tag por commit). */
  currentImage?: string | null;
  /** Imagem anterior, usada no rollback automático. */
  previousImage?: string | null;
  /** Healthcheck Docker configurado (JSON serializado). */
  healthcheckConfig?: string | null;
  /**
   * Limite de memória do container de TESTE (staging) deste projeto, em MB.
   * Ausente/null = rateio automático. Vale SÓ para o container de teste.
   */
  stagingMemoryLimitMb?: number | null;
  /**
   * Timeout (segundos) da espera de health do container de TESTE.
   * Ausente/null = default. Vale SÓ para o staging.
   */
  stagingHealthTimeoutSeconds?: number | null;
  createdAt: string;
}

export interface DetectedStack {
  language: string;
  framework: string | null;
  packageManager: string | null;
  recommendedPort: number | null;
  startCommand: string | null;
  buildCommand: string | null;
  // Nome do binário/artefato final. Só usado por linguagens compiladas onde o
  // Dockerfile precisa saber o nome exato pra copiar (ex: nome do pacote Rust).
  entryPoint: string | null;
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

// Teto de memória por container de projeto implantado pelo Korrelo, por tier de VPS.
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
  memLimitMb: number | null;
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
  /**
   * true quando estes números vêm de um cache (a coleta real falhou ou ficou
   * lenta demais) e podem estar desatualizados. A UI precisa avisar isso em
   * vez de mostrar o valor antigo como se fosse o atual.
   */
  stale?: boolean;
  /**
   * false quando não foi possível obter NENHUMA métrica (Docker e disco
   * indisponíveis). A UI deve mostrar "indisponível" em vez de 0%.
   */
  available?: boolean;
  /**
   * false quando o Docker não respondeu (timeout/erro). Evita que uma falha
   * de coleta seja lida como "não existe container rodando".
   */
  dockerReachable?: boolean;
  /** Momento (ISO) da coleta que originou estes valores. */
  collectedAt?: string;
}
