import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  STAGING_PORT_LEASE_REPOSITORY,
  type StagingLeaseStatus,
  type StagingPortLease,
  type StagingPortLeaseRepository,
} from "../domain/staging-lease";
import type {
  StagingCapacityDecision,
  StagingCapacityPolicy,
  StagingCapacityRequest,
} from "../domain/staging-capacity";
import {
  STAGING_PORT_PROBE,
  type StagingPortProbe,
} from "../domain/staging-context";
import type { StagingResourceRequest } from "../domain/staging-planner";
import { StagingCapacityService } from "./staging-capacity.service";
import { LocalStagingPortProbe } from "../infrastructure/read-only-staging-context.collector";

export interface AcquireStagingLeaseRequest {
  projectId: string;
  runId: string;
  ownerId?: string | null;
  portCandidates: number[];
  ttlMinutes: number;
  app: StagingResourceRequest;
  dependencies: StagingResourceRequest[];
  policy: StagingCapacityPolicy;
}

export interface StagingLeaseIssue {
  code: string;
  field: string;
  message: string;
}

export interface StagingLeaseAcquisitionResult {
  ok: boolean;
  lease: StagingPortLease | null;
  issues: StagingLeaseIssue[];
  capacity: StagingCapacityDecision | null;
}

/**
 * Aquisição separada da consulta de capacidade.
 *
 * Garantia real:
 *  - o mutex serializa aquisições NESTE processo;
 *  - a unique constraint de `portKey` bloqueia duplicidade no banco;
 *  - a sonda TCP evita candidato já ocupado, mas NÃO reserva no SO.
 */
@Injectable()
export class StagingPortLeaseService {
  constructor(
    @Inject(STAGING_PORT_LEASE_REPOSITORY) private readonly repository: StagingPortLeaseRepository,
    private readonly capacityService: StagingCapacityService,
    @Optional()
    @Inject(STAGING_PORT_PROBE)
    portProbe: StagingPortProbe | null = null,
  ) {
    this.portProbe = portProbe ?? new LocalStagingPortProbe();
  }

  private readonly portProbe: StagingPortProbe;
  private queue: Promise<unknown> = Promise.resolve();

  evaluateCapacity(request: StagingCapacityRequest): Promise<StagingCapacityDecision> {
    return this.capacityService.evaluate(request);
  }

  async acquire(request: AcquireStagingLeaseRequest): Promise<StagingLeaseAcquisitionResult> {
    return this.runExclusive(async () => {
      const capacityRequest: StagingCapacityRequest = {
        app: request.app,
        dependencies: request.dependencies,
        ttlMinutes: request.ttlMinutes,
        policy: request.policy,
      };
      const capacity = await this.capacityService.evaluate(capacityRequest);
      if (!capacity.ok) {
        return {
          ok: false,
          lease: null,
          issues: capacity.issues,
          capacity,
        };
      }

      let unavailable: number[];
      try {
        unavailable = await this.portProbe.findUnavailable(request.portCandidates);
      } catch {
        return {
          ok: false,
          lease: null,
          issues: [
            {
              code: "STAGING_LEASE_PORT_PROBE_UNAVAILABLE",
              field: "portCandidates",
              message: "Não foi possível sondar as portas candidatas.",
            },
          ],
          capacity,
        };
      }

      const blocked = new Set(unavailable);
      const candidates = request.portCandidates.filter(
        (port) => Number.isInteger(port) && port >= 1024 && port <= 65535 && !blocked.has(port),
      );
      if (candidates.length === 0) {
        return {
          ok: false,
          lease: null,
          issues: [
            {
              code: "STAGING_LEASE_PORT_UNAVAILABLE",
              field: "portCandidates",
              message: "Nenhuma porta candidata está livre.",
            },
          ],
          capacity,
        };
      }

      for (const hostPort of candidates) {
        try {
          const lease = await this.repository.create({
            projectId: request.projectId,
            runId: request.runId,
            hostPort,
            memoryMb: capacity.metrics?.requiredMemoryMb ?? request.app.memoryMb,
            cpu: capacity.metrics?.requiredCpu ?? request.app.cpu,
            diskMb: capacity.metrics?.requiredDiskMb ?? request.app.diskMb,
            ttlMinutes: request.ttlMinutes,
            ownerId: request.ownerId ?? null,
          });
          return { ok: true, lease, issues: [], capacity };
        } catch (error) {
          if (!isUniqueViolation(error)) {
            return {
              ok: false,
              lease: null,
              issues: [
                {
                  code: "STAGING_LEASE_DB_ERROR",
                  field: "lease",
                  message: "Falha ao gravar a reserva de porta.",
                },
              ],
              capacity,
            };
          }
          // Porta tomada por outro worker/processo: tenta a próxima.
        }
      }

      return {
        ok: false,
        lease: null,
        issues: [
          {
            code: "STAGING_LEASE_PORT_UNAVAILABLE",
            field: "portCandidates",
            message: "Todas as portas candidatas conflitaram no banco.",
          },
        ],
        capacity,
      };
    });
  }

  async release(
    projectId: string,
    runId: string,
    options: { allowConflict?: boolean } = {},
  ): Promise<{ ok: boolean; lease: StagingPortLease | null; reason: string | null }> {
    return this.repository.release(projectId, runId, options);
  }

  async status(projectId: string, runId: string): Promise<StagingLeaseStatus | null> {
    const lease = await this.repository.findByProjectAndRun(projectId, runId);
    return lease?.status ?? null;
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "P2002";
}
