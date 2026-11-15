import type { StagingCapacityDecision, StagingCapacityPolicy } from "./staging-capacity";
import type { StagingPortLease } from "./staging-lease";
import type { StagingResourceRequest } from "./staging-planner";

/**
 * P1B3 — EXECUÇÃO TEMPORÁRIA PERSISTIDA.
 *
 * Nenhum container é criado nesta camada. O registro é a fonte de ownership
 * que complementa (nunca substitui) labels e inventário na futura execução.
 */
export type StagingRunStatus =
  | "reserved"
  | "creating"
  | "running"
  | "validated"
  | "cleanup"
  | "destroyed"
  | "expired"
  | "conflict"
  | "failed";

export interface StagingRun {
  id: string;
  projectId: string;
  deployJobId: string | null;
  runId: string;
  composeProject: string;
  status: StagingRunStatus;
  planHash: string;
  composeHash: string;
  imageReference: string | null;
  imageId: string | null;
  imageDigest: string | null;
  memoryMb: number;
  cpu: number;
  diskMb: number;
  leaseId: string;
  networkName: string | null;
  volumePrefix: string | null;
  ownerId: string | null;
  cleanupState: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export interface ReserveStagingRunInput {
  projectId: string;
  deployJobId?: string | null;
  runId: string;
  composeProject: string;
  planHash: string;
  composeHash: string;
  imageReference?: string | null;
  imageId?: string | null;
  imageDigest?: string | null;
  app: StagingResourceRequest;
  dependencies: StagingResourceRequest[];
  portCandidates: number[];
  ttlMinutes: number;
  ownerId?: string | null;
  policy: StagingCapacityPolicy;
  networkName?: string | null;
  volumePrefix?: string | null;
}

export interface StagingRunIssue {
  code: string;
  field: string;
  message: string;
}

export interface ReserveStagingRunResult {
  ok: boolean;
  run: StagingRun | null;
  lease: StagingPortLease | null;
  issues: StagingRunIssue[];
  capacity: StagingCapacityDecision | null;
}

export interface ObservedStagingResource {
  kind: "container" | "network" | "volume";
  name: string;
  labels: Record<string, string>;
  composeProject?: string | null;
}

export interface StagingOwnershipResult {
  ok: boolean;
  issues: StagingRunIssue[];
}

export const STAGING_RUN_REPOSITORY = Symbol("STAGING_RUN_REPOSITORY");

export interface StagingRunRepository {
  reserve(input: ReserveStagingRunInput): Promise<ReserveStagingRunResult>;
  findByProjectAndRun(projectId: string, runId: string): Promise<StagingRun | null>;
  findExpired(now: Date): Promise<StagingRun[]>;
  /** Atualiza run e lease na MESMA transação, revalidando TTL/identidade. */
  recoverRun(input: RecoverStagingRunInput): Promise<RecoverStagingRunResult>;
}

export type StagingRunRecoveryOutcome = "expired" | "conflict";

export interface RecoverStagingRunInput {
  projectId: string;
  runId: string;
  now: Date;
  outcome: StagingRunRecoveryOutcome;
}

export interface RecoverStagingRunResult {
  ok: boolean;
  run: StagingRun | null;
  lease: StagingPortLease | null;
  /** "renewed" = TTL foi renovado/inativo; não sobrescrever. */
  reason: "not_found" | "renewed" | "inactive" | "lease_mismatch" | null;
}

/**
 * Ownership exige registro persistido E labels correspondentes.
 * Nome, sufixo ou label isolada NUNCA são autorização de exclusão.
 */
export function verifyStagingRunOwnership(
  run: StagingRun,
  resource: ObservedStagingResource,
): StagingOwnershipResult {
  const issues: StagingRunIssue[] = [];
  const add = (field: string, message: string) => issues.push({ code: "STAGING_OWNERSHIP_MISMATCH", field, message });

  if (resource.labels["korrelo.projectId"] !== run.projectId) {
    add("labels.korrelo.projectId", "projectId do recurso não corresponde ao StagingRun.");
  }
  if (resource.labels["korrelo.stagingRunId"] !== run.runId) {
    add("labels.korrelo.stagingRunId", "stagingRunId do recurso não corresponde ao StagingRun.");
  }
  if (resource.labels["korrelo.ephemeral"] !== "true") {
    add("labels.korrelo.ephemeral", "Recurso não está marcado como efêmero.");
  }
  if (run.deployJobId && resource.labels["korrelo.deployJobId"] !== run.deployJobId) {
    add("labels.korrelo.deployJobId", "deployJobId do recurso não corresponde ao StagingRun.");
  }
  const composeProject = resource.composeProject ?? resource.labels["com.docker.compose.project"] ?? null;
  if (composeProject !== run.composeProject) {
    add("labels.com.docker.compose.project", "Projeto Compose do recurso não corresponde ao StagingRun.");
  }

  return { ok: issues.length === 0, issues };
}
