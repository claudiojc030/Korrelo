import type {
  StagingDependencyConfig,
  StagingHostCapacity,
  StagingPlan,
  StagingProductionContext,
  StagingProjectConfig,
} from "./staging-planner";

/**
 * CONTEXTO DO STAGING ISOLADO (P1A — somente leitura).
 *
 * Nenhum adaptador desta camada pode criar, iniciar, remover ou alterar
 * recursos. O objetivo é apenas fornecer ao planejador do P0 dados explícitos
 * e verificáveis.
 */

export const STAGING_CONTEXT_COLLECTOR = Symbol("STAGING_CONTEXT_COLLECTOR");
export const STAGING_RUNTIME_INVENTORY = Symbol("STAGING_RUNTIME_INVENTORY");
export const STAGING_HOST_METRICS = Symbol("STAGING_HOST_METRICS");
export const STAGING_PORT_PROBE = Symbol("STAGING_PORT_PROBE");

export interface StagingContextCollectRequest {
  projectId: string;
  portCandidates: number[];
  maxConcurrentEnvironments: number;
  maxTtlMinutes: number;
}

export interface StagingContextSnapshot {
  production: StagingProductionContext;
  host: StagingHostCapacity;
  warnings: string[];
}

/**
 * Código textual próprio para o dry-run. Os issues do planejador (P0) são
 * estruturais e podem ser reaproveitados; erros de coleta usam estes códigos.
 */
export interface StagingDryRunIssue {
  code: string;
  field: string;
  message: string;
}

export interface StagingContextCollectionResult {
  ok: boolean;
  snapshot: StagingContextSnapshot | null;
  issues: StagingDryRunIssue[];
}

export interface StagingContextCollector {
  collect(request: StagingContextCollectRequest): Promise<StagingContextCollectionResult>;
}

export interface StagingRuntimeInventorySnapshot {
  activeStagingEnvironments: number;
  /** Portas publicadas por containers existentes (somente leitura). */
  unavailablePorts: number[];
}

export interface StagingRuntimeInventory {
  inspect(): Promise<StagingRuntimeInventorySnapshot>;
}

export interface StagingHostMetricsSnapshot {
  availableCpu: number | null;
  availableMemoryMb: number | null;
  freeDiskMb: number | null;
}

export interface StagingHostMetricsReader {
  read(): Promise<StagingHostMetricsSnapshot>;
}

/**
 * Sonda SOMENTE LEITURA de portas. Conecta para verificar uso; nunca faz bind,
 * listen ou publica porta.
 */
export interface StagingPortProbe {
  findUnavailable(ports: number[]): Promise<number[]>;
}

export interface StagingDryRunInput {
  projectId: string;
  /** Configuração explícita; ausente/null = legado. */
  config?: StagingProjectConfig | null;
  dependencies?: StagingDependencyConfig[];
  /** Identificador de execução apenas para nomes determinísticos do plano. */
  runId?: string;
  /** Candidatos vêm do alocador/operador; o dry-run não abre portas. */
  portCandidates: number[];
  maxConcurrentEnvironments?: number;
  maxTtlMinutes?: number;
  authorizedBindMounts?: string[];
}

export interface StagingDryRunResult {
  projectId: string;
  ok: boolean;
  mode: "legacy" | "isolated";
  legacy: boolean;
  plan: StagingPlan | null;
  issues: StagingDryRunIssue[];
  contextWarnings: string[];
}
