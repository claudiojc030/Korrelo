import { Inject, Injectable, Optional } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import type { StagingHostMetricsReader } from "../domain/staging-context";
import { STAGING_HOST_METRICS, STAGING_PORT_PROBE, type StagingPortProbe } from "../domain/staging-context";
import { StagingCapacityService } from "../application/staging-capacity.service";
import type {
  RecoverStagingRunInput,
  RecoverStagingRunResult,
  ReserveStagingRunInput,
  ReserveStagingRunResult,
  StagingRun,
  StagingRunRepository,
  StagingRunStatus,
} from "../domain/staging-run";
import type { StagingPortLease } from "../domain/staging-lease";
import { LocalStagingHostMetrics, LocalStagingPortProbe } from "./read-only-staging-context.collector";

/**
 * Reserva ATÔMICA de capacidade + porta + StagingRun.
 *
 * SQLite:
 * - a primeira escrita da transação é o UPSERT do coordenador global; isso
 *   adquire o write lock do SQLite antes da leitura das reservas;
 * - o lease e o run são criados na MESMA transação;
 * - unique `portKey` é a barreira final entre processos para a porta;
 * - unique `(projectId, runId)` impede run duplicado;
 * - erro de porta ocupada reinicia a transação no próximo candidato.
 *
 * Não existe mutex de memória como garantia principal.
 */
@Injectable()
export class PrismaStagingRunRepository implements StagingRunRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capacityService: StagingCapacityService,
    @Optional() @Inject(STAGING_HOST_METRICS) hostMetrics: StagingHostMetricsReader | null = null,
    @Optional() @Inject(STAGING_PORT_PROBE) portProbe: StagingPortProbe | null = null,
  ) {
    this.hostMetrics = hostMetrics ?? new LocalStagingHostMetrics();
    this.portProbe = portProbe ?? new LocalStagingPortProbe();
  }

  private readonly hostMetrics: StagingHostMetricsReader;
  private readonly portProbe: StagingPortProbe;

  async reserve(input: ReserveStagingRunInput): Promise<ReserveStagingRunResult> {
    const candidates = (input.portCandidates ?? []).filter(
      (port) => Number.isInteger(port) && port >= 1024 && port <= 65535,
    );
    if (candidates.length === 0) {
      return {
        ok: false,
        run: null,
        lease: null,
        issues: [
          {
            code: "STAGING_RUN_PORT_UNAVAILABLE",
            field: "portCandidates",
            message: "Nenhuma porta candidata válida foi informada.",
          },
        ],
        capacity: null,
      };
    }

    let host;
    try {
      host = await this.hostMetrics.read();
    } catch {
      return {
        ok: false,
        run: null,
        lease: null,
        issues: [
          {
            code: "STAGING_RUN_CAPACITY_UNAVAILABLE",
            field: "host",
            message: "Host indisponível para leitura.",
          },
        ],
        capacity: null,
      };
    }
    if (!isCompleteHost(host)) {
      return {
        ok: false,
        run: null,
        lease: null,
        issues: [
          {
            code: "STAGING_RUN_CAPACITY_INCOMPLETE",
            field: "host",
            message: "CPU, memória ou disco do host não pôde ser determinado.",
          },
        ],
        capacity: null,
      };
    }

    let unavailable: number[];
    try {
      unavailable = await this.portProbe.findUnavailable(candidates);
    } catch {
      return {
        ok: false,
        run: null,
        lease: null,
        issues: [
          {
            code: "STAGING_RUN_PORT_PROBE_UNAVAILABLE",
            field: "portCandidates",
            message: "Não foi possível sondar as portas candidatas.",
          },
        ],
        capacity: null,
      };
    }

    const blocked = new Set(unavailable);
    const availableCandidates = candidates.filter((port) => !blocked.has(port));
    if (availableCandidates.length === 0) {
      return {
        ok: false,
        run: null,
        lease: null,
        issues: [
          {
            code: "STAGING_RUN_PORT_UNAVAILABLE",
            field: "portCandidates",
            message: "Nenhuma porta candidata está livre.",
          },
        ],
        capacity: null,
      };
    }

    for (const hostPort of availableCandidates) {
      try {
        const result = await this.prisma.$transaction(
          async (tx) => {
            // Primeira ESCRITA: adquire o write lock do SQLite antes de
            // qualquer leitura de capacidade. A versão é apenas diagnóstico.
            await tx.stagingCoordinator.upsert({
              where: { id: "global" },
              create: { id: "global", version: 1, updatedAt: new Date() },
              update: { version: { increment: 1 } },
            });

            const leaseRows = await tx.stagingPortLease.findMany({
              where: { portKey: { not: null } },
              orderBy: { createdAt: "asc" },
            });
            const liveLeases = leaseRows.map((row) => toLease(row));
            const capacity = this.capacityService.evaluateWithLeases(
              {
                app: input.app,
                dependencies: input.dependencies,
                ttlMinutes: input.ttlMinutes,
                policy: input.policy,
              },
              host,
              liveLeases,
            );
            if (!capacity.ok) throw new CapacityReservationError(capacity);

            const now = new Date();
            const expiresAt = new Date(now.getTime() + input.ttlMinutes * 60_000);
            const leaseRow = await tx.stagingPortLease.create({
              data: {
                projectId: input.projectId,
                runId: input.runId,
                hostPort,
                portKey: `port:${hostPort}`,
                status: "active",
                expiresAt,
                memoryMb: capacity.metrics!.requiredMemoryMb,
                cpu: capacity.metrics!.requiredCpu,
                diskMb: capacity.metrics!.requiredDiskMb,
                ownerId: input.ownerId ?? null,
              },
            });

            const runRow = await tx.stagingRun.create({
              data: {
                projectId: input.projectId,
                deployJobId: input.deployJobId ?? null,
                runId: input.runId,
                composeProject: input.composeProject,
                status: "reserved",
                planHash: input.planHash,
                composeHash: input.composeHash,
                imageReference: input.imageReference ?? null,
                imageId: input.imageId ?? null,
                imageDigest: input.imageDigest ?? null,
                memoryMb: capacity.metrics!.requiredMemoryMb,
                cpu: capacity.metrics!.requiredCpu,
                diskMb: capacity.metrics!.requiredDiskMb,
                leaseId: leaseRow.id,
                networkName: input.networkName ?? null,
                volumePrefix: input.volumePrefix ?? null,
                ownerId: input.ownerId ?? null,
                cleanupState: "none",
                expiresAt,
              },
            });

            return {
              ok: true as const,
              lease: toLease(leaseRow),
              run: toRun(runRow),
              capacity,
            };
          },
          { maxWait: 5_000, timeout: 15_000 },
        );
        return { ...result, issues: [] };
      } catch (error) {
        if (error instanceof CapacityReservationError) {
          return {
            ok: false,
            run: null,
            lease: null,
            issues: error.decision.issues,
            capacity: error.decision,
          };
        }
        if (isUniqueViolation(error)) {
          const target = uniqueTarget(error);
          if (target.includes("portKey")) continue;
          if (target.includes("projectId") || target.includes("runId")) {
            return {
              ok: false,
              run: null,
              lease: null,
              issues: [
                {
                  code: "STAGING_RUN_DUPLICATE",
                  field: "runId",
                  message: "Já existe um StagingRun para este projeto/execução.",
                },
              ],
              capacity: null,
            };
          }
        }
        return {
          ok: false,
          run: null,
          lease: null,
          issues: [
            {
              code: "STAGING_RUN_DB_ERROR",
              field: "transaction",
              message: "Falha ao reservar capacidade e porta; transação revertida.",
            },
          ],
          capacity: null,
        };
      }
    }

    return {
      ok: false,
      run: null,
      lease: null,
      issues: [
        {
          code: "STAGING_RUN_PORT_UNAVAILABLE",
          field: "portCandidates",
          message: "Todas as portas candidatas conflitaram no banco.",
        },
      ],
      capacity: null,
    };
  }

  async findByProjectAndRun(projectId: string, runId: string): Promise<StagingRun | null> {
    const row = await this.prisma.stagingRun.findUnique({
      where: { projectId_runId: { projectId, runId } },
    });
    return row ? toRun(row) : null;
  }

  async findExpired(now: Date): Promise<StagingRun[]> {
    const rows = await this.prisma.stagingRun.findMany({
      where: {
        status: { in: ["reserved", "creating", "running", "validated", "cleanup"] },
        expiresAt: { lte: now },
      },
      orderBy: { expiresAt: "asc" },
    });
    return rows.map((row) => toRun(row));
  }

  async recoverRun(input: RecoverStagingRunInput): Promise<RecoverStagingRunResult> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Mesma ordem do reserve: coordenador primeiro para serializar com
          // renovações/aquisições concorrentes.
          await tx.stagingCoordinator.upsert({
            where: { id: "global" },
            create: { id: "global", version: 1, updatedAt: new Date() },
            update: { version: { increment: 1 } },
          });

          const runRow = await tx.stagingRun.findUnique({
            where: { projectId_runId: { projectId: input.projectId, runId: input.runId } },
          });
          if (!runRow) {
            return { ok: false, run: null, lease: null, reason: "not_found" as const };
          }
          const run = toRun(runRow);
          if (
            !["reserved", "creating", "running", "validated", "cleanup"].includes(run.status) ||
            run.expiresAt > input.now
          ) {
            return { ok: false, run, lease: null, reason: "renewed" as const };
          }
          const leaseRow = await tx.stagingPortLease.findUnique({ where: { id: run.leaseId } });
          if (
            !leaseRow ||
            leaseRow.projectId !== input.projectId ||
            leaseRow.runId !== input.runId
          ) {
            return { ok: false, run, lease: null, reason: "lease_mismatch" as const };
          }
          if (leaseRow.status !== "active" || leaseRow.expiresAt > input.now) {
            return { ok: false, run, lease: toLease(leaseRow), reason: "renewed" as const };
          }

          const now = new Date();
          const leaseUpdate =
            input.outcome === "conflict"
              ? { status: "conflict", updatedAt: now }
              : { status: "expired", portKey: null, updatedAt: now };
          const runUpdate =
            input.outcome === "conflict"
              ? { status: "conflict", cleanupState: "conflict", updatedAt: now }
              : { status: "expired", cleanupState: "expired", updatedAt: now };

          const updatedLease = await tx.stagingPortLease.update({
            where: { id: leaseRow.id },
            data: leaseUpdate,
          });
          const updatedRun = await tx.stagingRun.update({
            where: { id: run.id },
            data: runUpdate,
          });
          return { ok: true, run: toRun(updatedRun), lease: toLease(updatedLease), reason: null };
        },
        { maxWait: 5_000, timeout: 15_000 },
      );
    } catch {
      return { ok: false, run: null, lease: null, reason: null };
    }
  }

}

class CapacityReservationError extends Error {
  constructor(public readonly decision: ReturnType<StagingCapacityService["evaluateWithLeases"]>) {
    super("capacidade insuficiente");
    this.name = "CapacityReservationError";
  }
}

function isCompleteHost(host: { availableCpu: number | null; availableMemoryMb: number | null; freeDiskMb: number | null }): boolean {
  return (
    typeof host.availableCpu === "number" &&
    Number.isFinite(host.availableCpu) &&
    host.availableCpu >= 0 &&
    typeof host.availableMemoryMb === "number" &&
    Number.isFinite(host.availableMemoryMb) &&
    host.availableMemoryMb >= 0 &&
    typeof host.freeDiskMb === "number" &&
    Number.isFinite(host.freeDiskMb) &&
    host.freeDiskMb >= 0
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "P2002";
}

function uniqueTarget(error: unknown): string[] {
  const target = (error as { meta?: { target?: unknown } } | null)?.meta?.target;
  if (Array.isArray(target)) return target.map(String);
  if (typeof target === "string") return [target];
  return [];
}

function toLease(row: {
  id: string;
  projectId: string;
  runId: string;
  hostPort: number;
  status: string;
  expiresAt: Date;
  memoryMb: number;
  cpu: number;
  diskMb: number;
  ownerId: string | null;
  createdAt: Date;
  updatedAt: Date;
  releasedAt: Date | null;
}): StagingPortLease {
  return {
    id: row.id,
    projectId: row.projectId,
    runId: row.runId,
    hostPort: row.hostPort,
    status: row.status as StagingPortLease["status"],
    expiresAt: row.expiresAt,
    memoryMb: row.memoryMb,
    cpu: row.cpu,
    diskMb: row.diskMb,
    ownerId: row.ownerId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    releasedAt: row.releasedAt,
  };
}

function toRun(row: {
  id: string;
  projectId: string;
  deployJobId: string | null;
  runId: string;
  composeProject: string;
  status: string;
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
}): StagingRun {
  return {
    id: row.id,
    projectId: row.projectId,
    deployJobId: row.deployJobId,
    runId: row.runId,
    composeProject: row.composeProject,
    status: row.status as StagingRunStatus,
    planHash: row.planHash,
    composeHash: row.composeHash,
    imageReference: row.imageReference,
    imageId: row.imageId,
    imageDigest: row.imageDigest,
    memoryMb: row.memoryMb,
    cpu: row.cpu,
    diskMb: row.diskMb,
    leaseId: row.leaseId,
    networkName: row.networkName,
    volumePrefix: row.volumePrefix,
    ownerId: row.ownerId,
    cleanupState: row.cleanupState,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
  };
}
