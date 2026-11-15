import type { StagingResourceRequest } from "./staging-planner";

/**
 * P1B2 — AVALIAÇÃO DE CAPACIDADE (somente leitura).
 *
 * A consulta de capacidade NÃO adquire lease. A aquisição é uma operação
 * separada e explícita no serviço de lease.
 */
export interface StagingCapacityPolicy {
  maxConcurrentEnvironments: number;
  maxTtlMinutes: number;
  /** Reservas/margens explícitas; não existem valores fixos escondidos. */
  productionReservedMemoryMb: number;
  productionReservedCpu: number;
  productionReservedDiskMb: number;
  safetyMemoryMb: number;
  safetyCpu: number;
  safetyDiskMb: number;
}

export interface StagingCapacityRequest {
  app: StagingResourceRequest;
  dependencies: StagingResourceRequest[];
  ttlMinutes: number;
  policy: StagingCapacityPolicy;
}

export interface StagingCapacityIssue {
  code: string;
  field: string;
  message: string;
}

export interface StagingCapacityMetrics {
  hostAvailableCpu: number | null;
  hostAvailableMemoryMb: number | null;
  hostFreeDiskMb: number | null;
  requiredMemoryMb: number;
  requiredCpu: number;
  requiredDiskMb: number;
  reservedMemoryMb: number;
  reservedCpu: number;
  reservedDiskMb: number;
  activeEnvironments: number;
  availableMemoryMb: number;
  availableCpu: number;
  availableDiskMb: number;
}

export interface StagingCapacityDecision {
  ok: boolean;
  issues: StagingCapacityIssue[];
  metrics: StagingCapacityMetrics | null;
}
