import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  STAGING_PORT_LEASE_REPOSITORY,
  type StagingPortLeaseRepository,
} from "../domain/staging-lease";
import {
  type StagingCapacityDecision,
  type StagingCapacityIssue,
  type StagingCapacityMetrics,
  type StagingCapacityRequest,
} from "../domain/staging-capacity";
import {
  STAGING_HOST_METRICS,
  type StagingHostMetricsReader,
} from "../domain/staging-context";
import { LocalStagingHostMetrics } from "../infrastructure/read-only-staging-context.collector";

/**
 * Avaliação PURA de capacidade: consulta host e leases existentes e devolve
 * decisão. Não adquire lease, não escreve no banco e não toca em Docker.
 */
@Injectable()
export class StagingCapacityService {
  constructor(
    @Inject(STAGING_PORT_LEASE_REPOSITORY) private readonly leaseRepository: StagingPortLeaseRepository,
    @Optional()
    @Inject(STAGING_HOST_METRICS)
    hostMetrics: StagingHostMetricsReader | null = null,
  ) {
    this.hostMetrics = hostMetrics ?? new LocalStagingHostMetrics();
  }

  private readonly hostMetrics: StagingHostMetricsReader;

  async evaluate(request: StagingCapacityRequest): Promise<StagingCapacityDecision> {
    const issues: StagingCapacityIssue[] = [];
    const add = (code: string, field: string, message: string) => issues.push({ code, field, message });

    const policy = request.policy;
    if (!Number.isInteger(policy.maxConcurrentEnvironments) || policy.maxConcurrentEnvironments <= 0) {
      add("STAGING_CAPACITY_POLICY_INVALID", "policy.maxConcurrentEnvironments", "Máximo de ambientes inválido.");
    }
    if (!Number.isInteger(policy.maxTtlMinutes) || policy.maxTtlMinutes <= 0) {
      add("STAGING_CAPACITY_POLICY_INVALID", "policy.maxTtlMinutes", "TTL máximo inválido.");
    }
    for (const [field, value] of [
      ["productionReservedMemoryMb", policy.productionReservedMemoryMb],
      ["productionReservedCpu", policy.productionReservedCpu],
      ["productionReservedDiskMb", policy.productionReservedDiskMb],
      ["safetyMemoryMb", policy.safetyMemoryMb],
      ["safetyCpu", policy.safetyCpu],
      ["safetyDiskMb", policy.safetyDiskMb],
    ] as const) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        add("STAGING_CAPACITY_POLICY_INVALID", `policy.${field}`, "Margem/reserva precisa ser explícita e >= 0.");
      }
    }
    if (!Number.isInteger(request.ttlMinutes) || request.ttlMinutes <= 0) {
      add("STAGING_CAPACITY_TTL_INVALID", "ttlMinutes", "ttlMinutes precisa ser inteiro > 0.");
    } else if (Number.isInteger(policy.maxTtlMinutes) && request.ttlMinutes > policy.maxTtlMinutes) {
      add(
        "STAGING_CAPACITY_TTL_INVALID",
        "ttlMinutes",
        `TTL ${request.ttlMinutes} excede o máximo de ${policy.maxTtlMinutes}.`,
      );
    }
    const resources = [request.app, ...request.dependencies];
    for (const [index, resource] of resources.entries()) {
      if (!resource || !isNonNegative(resource.memoryMb) || !isNonNegative(resource.cpu) || !isNonNegative(resource.diskMb)) {
        add("STAGING_CAPACITY_RESOURCE_INVALID", `resources[${index}]`, "Recurso precisa ser explícito e >= 0.");
      }
    }
    if (issues.length > 0) return { ok: false, issues, metrics: null };

    let host;
    try {
      host = await this.hostMetrics.read();
    } catch {
      return {
        ok: false,
        issues: [{ code: "STAGING_CAPACITY_UNAVAILABLE", field: "host", message: "Host indisponível para leitura." }],
        metrics: null,
      };
    }
    if (
      !isNonNegative(host.availableCpu) ||
      !isNonNegative(host.availableMemoryMb) ||
      !isNonNegative(host.freeDiskMb)
    ) {
      return {
        ok: false,
        issues: [
          {
            code: "STAGING_CAPACITY_INCOMPLETE",
            field: "host",
            message: "CPU, memória ou disco do host não pôde ser determinado.",
          },
        ],
        metrics: null,
      };
    }

    let liveLeases;
    try {
      liveLeases = await this.leaseRepository.findLive();
    } catch {
      return {
        ok: false,
        issues: [
          {
            code: "STAGING_CAPACITY_UNAVAILABLE",
            field: "leases",
            message: "Não foi possível ler as reservas existentes.",
          },
        ],
        metrics: null,
      };
    }

    const requiredMemoryMb = resources.reduce((sum, resource) => sum + resource.memoryMb, 0);
    const requiredCpu = resources.reduce((sum, resource) => sum + resource.cpu, 0);
    const requiredDiskMb = resources.reduce((sum, resource) => sum + resource.diskMb, 0);
    const reservedMemoryMb = liveLeases.reduce((sum, lease) => sum + lease.memoryMb, 0);
    const reservedCpu = liveLeases.reduce((sum, lease) => sum + lease.cpu, 0);
    const reservedDiskMb = liveLeases.reduce((sum, lease) => sum + lease.diskMb, 0);

    const availableMemoryMb = Math.max(
      0,
      host.availableMemoryMb - policy.productionReservedMemoryMb - policy.safetyMemoryMb,
    );
    const availableCpu = Math.max(0, host.availableCpu - policy.productionReservedCpu - policy.safetyCpu);
    const availableDiskMb = Math.max(0, host.freeDiskMb - policy.productionReservedDiskMb - policy.safetyDiskMb);

    const metrics: StagingCapacityMetrics = {
      hostAvailableCpu: host.availableCpu,
      hostAvailableMemoryMb: host.availableMemoryMb,
      hostFreeDiskMb: host.freeDiskMb,
      requiredMemoryMb,
      requiredCpu,
      requiredDiskMb,
      reservedMemoryMb,
      reservedCpu,
      reservedDiskMb,
      activeEnvironments: liveLeases.length,
      availableMemoryMb,
      availableCpu,
      availableDiskMb,
    };

    if (liveLeases.length + 1 > policy.maxConcurrentEnvironments) {
      add(
        "STAGING_CAPACITY_CONCURRENCY",
        "activeEnvironments",
        `Limite de ambientes atingido (${liveLeases.length}/${policy.maxConcurrentEnvironments}).`,
      );
    }
    if (requiredMemoryMb + reservedMemoryMb > availableMemoryMb) {
      add(
        "STAGING_CAPACITY_MEMORY",
        "memoryMb",
        `Memória insuficiente: requerido ${requiredMemoryMb} + reservado ${reservedMemoryMb} > disponível ${availableMemoryMb} MB.`,
      );
    }
    if (requiredCpu + reservedCpu > availableCpu) {
      add(
        "STAGING_CAPACITY_CPU",
        "cpu",
        `CPU insuficiente: requerido ${requiredCpu} + reservado ${reservedCpu} > disponível ${availableCpu}.`,
      );
    }
    if (requiredDiskMb + reservedDiskMb > availableDiskMb) {
      add(
        "STAGING_CAPACITY_DISK",
        "diskMb",
        `Disco insuficiente: requerido ${requiredDiskMb} + reservado ${reservedDiskMb} > disponível ${availableDiskMb} MB.`,
      );
    }

    return { ok: issues.length === 0, issues, metrics };
  }
}

function isNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
