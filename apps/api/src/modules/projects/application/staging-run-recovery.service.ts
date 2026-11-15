import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  STAGING_RUN_REPOSITORY,
  verifyStagingRunOwnership,
  type StagingRun,
  type StagingRunRepository,
} from "../domain/staging-run";
import {
  STAGING_PORT_LEASE_REPOSITORY,
  type StagingPortLeaseRepository,
} from "../domain/staging-lease";
import {
  STAGING_DOCKER_INVENTORY,
  type StagingDockerInventoryReader,
  type StagingDockerInventorySnapshot,
} from "../domain/staging-docker-inventory";
import { ReadOnlyDockerInventoryReader } from "../infrastructure/read-only-docker-inventory.reader";

export interface StagingRunRecoveryIssue {
  code: string;
  field: string;
  message: string;
}

export interface StagingRunRecoveryResult {
  ok: boolean;
  inspected: number;
  expired: string[];
  conflicts: string[];
  orphans: string[];
  issues: StagingRunRecoveryIssue[];
}

/**
 * Recuperação conservadora de StagingRun.
 *
 * - inventário incompleto => nenhuma alteração;
 * - ownership exige registro + labels compatíveis;
 * - recurso/porta com evidência => run e lease viram conflict;
 * - sem evidência => run/lease expiram e a porta é liberada;
 * - nenhum container, rede ou volume é removido.
 */
@Injectable()
export class StagingRunRecoveryService {
  constructor(
    @Inject(STAGING_RUN_REPOSITORY) private readonly runRepository: StagingRunRepository,
    @Inject(STAGING_PORT_LEASE_REPOSITORY) private readonly leaseRepository: StagingPortLeaseRepository,
    @Optional()
    @Inject(STAGING_DOCKER_INVENTORY)
    inventory: StagingDockerInventoryReader | null = null,
  ) {
    this.inventory = inventory ?? new ReadOnlyDockerInventoryReader();
  }

  private readonly inventory: StagingDockerInventoryReader;

  async recover(options: { now?: Date; activeRunIds?: string[] } = {}): Promise<StagingRunRecoveryResult> {
    const now = options.now ?? new Date();
    const issues: StagingRunRecoveryIssue[] = [];
    const expired: string[] = [];
    const conflicts: string[] = [];
    const orphans: string[] = [];

    let inventory: StagingDockerInventorySnapshot;
    try {
      inventory = await this.inventory.inspect();
    } catch {
      return {
        ok: false,
        inspected: 0,
        expired,
        conflicts,
        orphans,
        issues: [
          {
            code: "STAGING_RECOVERY_INVENTORY_UNAVAILABLE",
            field: "docker",
            message: "Inventário Docker indisponível; nenhuma reserva foi alterada.",
          },
        ],
      };
    }
    if (!inventory.complete) {
      return {
        ok: false,
        inspected: 0,
        expired,
        conflicts,
        orphans,
        issues: [
          {
            code: "STAGING_RECOVERY_INVENTORY_INCOMPLETE",
            field: "docker",
            message: inventory.error ?? "Inventário Docker incompleto; nenhuma reserva foi alterada.",
          },
        ],
      };
    }

    let runs;
    try {
      runs = await this.runRepository.findExpired(now);
    } catch {
      return {
        ok: false,
        inspected: 0,
        expired,
        conflicts,
        orphans,
        issues: [
          {
            code: "STAGING_RECOVERY_DB_ERROR",
            field: "runs",
            message: "Não foi possível ler StagingRuns expirados.",
          },
        ],
      };
    }

    const activeRunIds = new Set(options.activeRunIds ?? []);
    for (const run of runs) {
      try {
        const lease = await this.leaseRepository.findByProjectAndRun(run.projectId, run.runId);
        const evidence = this.hasEvidence(run, lease?.hostPort ?? null, inventory, activeRunIds);
        const recovered = await this.runRepository.recoverRun({
          projectId: run.projectId,
          runId: run.runId,
          now,
          outcome: evidence ? "conflict" : "expired",
        });
        if (!recovered.ok) {
          if (recovered.reason === "renewed" || recovered.reason === "not_found") continue;
          issues.push({
            code: "STAGING_RECOVERY_UPDATE_FAILED",
            field: `runs.${run.id}`,
            message: `Falha ao recuperar o StagingRun (${recovered.reason ?? "transação revertida"}).`,
          });
          continue;
        }
        if (evidence) conflicts.push(run.runId);
        else expired.push(run.runId);
      } catch {
        issues.push({
          code: "STAGING_RECOVERY_UPDATE_FAILED",
          field: `runs.${run.id}`,
          message: "Falha ao atualizar a recuperação do StagingRun.",
        });
      }
    }

    const knownResources = [
      ...inventory.containers.map((resource) => ({
        kind: "container" as const,
        name: resource.name,
        labels: resource.labels,
      })),
      ...inventory.networks.map((resource) => ({
        kind: "network" as const,
        name: resource.name,
        labels: resource.labels,
      })),
      ...inventory.volumes.map((resource) => ({
        kind: "volume" as const,
        name: resource.name,
        labels: resource.labels,
      })),
    ];
    const seenOrphans = new Set<string>();
    for (const resource of knownResources) {
      const projectId = resource.labels["korrelo.projectId"];
      const runId = resource.labels["korrelo.stagingRunId"];
      if (!projectId || !runId || activeRunIds.has(runId)) continue;
      try {
        const run = await this.runRepository.findByProjectAndRun(projectId, runId);
        if (!run) {
          const key = `${resource.kind}:${resource.name}`;
          if (!seenOrphans.has(key)) {
            seenOrphans.add(key);
            orphans.push(key);
          }
        }
      } catch {
        issues.push({
          code: "STAGING_RECOVERY_DB_ERROR",
          field: "orphans",
          message: "Falha ao verificar recursos órfãos conhecidos.",
        });
      }
    }

    return {
      ok: issues.length === 0,
      inspected: runs.length,
      expired,
      conflicts,
      orphans,
      issues,
    };
  }

  private hasEvidence(
    run: StagingRun,
    hostPort: number | null,
    inventory: StagingDockerInventorySnapshot,
    activeRunIds: Set<string>,
  ): boolean {
    if (activeRunIds.has(run.runId)) return true;
    if (hostPort !== null && inventory.publishedPorts.includes(hostPort)) return true;
    return inventory.containers.some((container) => {
      const resource = {
        kind: "container" as const,
        name: container.name,
        labels: container.labels,
        composeProject: container.composeProject,
      };
      return verifyStagingRunOwnership(run, resource).ok;
    });
  }
}
