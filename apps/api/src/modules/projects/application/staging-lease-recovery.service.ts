import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  STAGING_PORT_LEASE_REPOSITORY,
  type StagingPortLeaseRepository,
} from "../domain/staging-lease";
import {
  STAGING_DOCKER_INVENTORY,
  type StagingDockerInventoryReader,
} from "../domain/staging-docker-inventory";
import { ReadOnlyDockerInventoryReader } from "../infrastructure/read-only-docker-inventory.reader";

export interface StagingLeaseRecoveryIssue {
  code: string;
  field: string;
  message: string;
}

export interface StagingLeaseRecoveryResult {
  ok: boolean;
  inspected: number;
  expired: string[];
  conflicts: string[];
  issues: StagingLeaseRecoveryIssue[];
}

/**
 * RECUPERAÇÃO CONSERVADORA.
 *
 * - não remove containers, redes ou volumes;
 * - não libera porta com evidência de uso;
 * - inventário incompleto => nenhuma alteração;
 * - lease sem evidência vira `expired` e libera a chave de porta;
 * - lease com evidência vira `conflict` e permanece bloqueando a porta.
 */
@Injectable()
export class StagingLeaseRecoveryService {
  constructor(
    @Inject(STAGING_PORT_LEASE_REPOSITORY) private readonly leaseRepository: StagingPortLeaseRepository,
    @Optional()
    @Inject(STAGING_DOCKER_INVENTORY)
    inventory: StagingDockerInventoryReader | null = null,
  ) {
    this.inventory = inventory ?? new ReadOnlyDockerInventoryReader();
  }

  private readonly inventory: StagingDockerInventoryReader;

  async recover(options: { now?: Date; activeRunIds?: string[] } = {}): Promise<StagingLeaseRecoveryResult> {
    const now = options.now ?? new Date();
    const issues: StagingLeaseRecoveryIssue[] = [];
    const expired: string[] = [];
    const conflicts: string[] = [];

    const inventory = await this.inventory.inspect();
    if (!inventory.complete) {
      return {
        ok: false,
        inspected: 0,
        expired,
        conflicts,
        issues: [
          {
            code: "STAGING_RECOVERY_INVENTORY_INCOMPLETE",
            field: "docker",
            message: inventory.error ?? "Inventário Docker incompleto; nenhuma reserva foi alterada.",
          },
        ],
      };
    }

    let leases;
    try {
      leases = await this.leaseRepository.findExpired(now);
    } catch {
      return {
        ok: false,
        inspected: 0,
        expired,
        conflicts,
        issues: [
          {
            code: "STAGING_RECOVERY_DB_ERROR",
            field: "leases",
            message: "Não foi possível ler leases expirados.",
          },
        ],
      };
    }

    const activeRunIds = new Set(options.activeRunIds ?? []);
    const containerRunIds = new Set(
      inventory.containers.flatMap((container) => {
        const values = [
          container.labels["korrelo.stagingRunId"],
          container.labels["korrelo.deployJobId"],
        ].filter((value): value is string => typeof value === "string" && value.length > 0);
        return values;
      }),
    );
    const publishedPorts = new Set(inventory.publishedPorts);

    for (const lease of leases) {
      const hasEvidence =
        activeRunIds.has(lease.runId) ||
        containerRunIds.has(lease.runId) ||
        publishedPorts.has(lease.hostPort);
      try {
        if (hasEvidence) {
          await this.leaseRepository.markConflict(lease.id);
          conflicts.push(lease.runId);
        } else {
          await this.leaseRepository.markExpired(lease.id);
          expired.push(lease.runId);
        }
      } catch {
        issues.push({
          code: "STAGING_RECOVERY_UPDATE_FAILED",
          field: `leases.${lease.id}`,
          message: "Falha ao atualizar o lease durante a recuperação.",
        });
      }
    }

    return {
      ok: issues.length === 0,
      inspected: leases.length,
      expired,
      conflicts,
      issues,
    };
  }
}
