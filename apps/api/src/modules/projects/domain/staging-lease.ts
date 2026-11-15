/**
 * P1B2 — LEASE INTERNO DE PORTA E RECURSOS.
 *
 * Garantia real:
 *  - a unicidade no banco impede duas reservas ATIVAS para a mesma porta no
 *    mesmo banco do Core;
 *  - a sonda TCP apenas evita candidatos já ocupados no momento da consulta;
 *    ela NÃO reserva a porta no sistema operacional.
 *
 * Não há bind/listen nem encerramento de processos nesta camada.
 */
export type StagingLeaseStatus = "active" | "expired" | "released" | "conflict";

export const STAGING_PORT_LEASE_REPOSITORY = Symbol("STAGING_PORT_LEASE_REPOSITORY");

export interface StagingPortLease {
  id: string;
  projectId: string;
  runId: string;
  hostPort: number;
  status: StagingLeaseStatus;
  expiresAt: Date;
  memoryMb: number;
  cpu: number;
  diskMb: number;
  ownerId: string | null;
  createdAt: Date;
  updatedAt: Date;
  releasedAt: Date | null;
}

export interface CreateStagingPortLeaseInput {
  projectId: string;
  runId: string;
  hostPort: number;
  memoryMb: number;
  cpu: number;
  diskMb: number;
  ttlMinutes: number;
  ownerId?: string | null;
  now?: Date;
}

export interface ReleaseStagingLeaseOptions {
  /** Necessário para liberar explicitamente um lease marcado como conflito. */
  allowConflict?: boolean;
  now?: Date;
}

export interface StagingPortLeaseRepository {
  create(input: CreateStagingPortLeaseInput): Promise<StagingPortLease>;
  /** Leases que ainda reservam porta/recurso (active, expired sem limpeza, conflict). */
  findLive(): Promise<StagingPortLease[]>;
  findExpired(now: Date): Promise<StagingPortLease[]>;
  findByProjectAndRun(projectId: string, runId: string): Promise<StagingPortLease | null>;
  markExpired(id: string): Promise<StagingPortLease | null>;
  markConflict(id: string): Promise<StagingPortLease | null>;
  release(
    projectId: string,
    runId: string,
    options?: ReleaseStagingLeaseOptions,
  ): Promise<{ ok: boolean; lease: StagingPortLease | null; reason: string | null }>;
}
