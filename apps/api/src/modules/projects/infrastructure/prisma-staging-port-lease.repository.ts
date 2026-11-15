import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import type {
  CreateStagingPortLeaseInput,
  ReleaseStagingLeaseOptions,
  StagingPortLease,
  StagingPortLeaseRepository,
  StagingLeaseStatus,
} from "../domain/staging-lease";

@Injectable()
export class PrismaStagingPortLeaseRepository implements StagingPortLeaseRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateStagingPortLeaseInput): Promise<StagingPortLease> {
    const now = input.now ?? new Date();
    const row = await this.prisma.stagingPortLease.create({
      data: {
        projectId: input.projectId,
        runId: input.runId,
        hostPort: input.hostPort,
        portKey: `port:${input.hostPort}`,
        status: "active",
        expiresAt: new Date(now.getTime() + input.ttlMinutes * 60_000),
        memoryMb: input.memoryMb,
        cpu: input.cpu,
        diskMb: input.diskMb,
        ownerId: input.ownerId ?? null,
      },
    });
    return this.toDomain(row);
  }

  async findLive(): Promise<StagingPortLease[]> {
    const rows = await this.prisma.stagingPortLease.findMany({
      where: { portKey: { not: null } },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => this.toDomain(row));
  }

  async findExpired(now: Date): Promise<StagingPortLease[]> {
    const rows = await this.prisma.stagingPortLease.findMany({
      where: { status: "active", expiresAt: { lte: now } },
      orderBy: { expiresAt: "asc" },
    });
    return rows.map((row) => this.toDomain(row));
  }

  async findByProjectAndRun(projectId: string, runId: string): Promise<StagingPortLease | null> {
    const row = await this.prisma.stagingPortLease.findUnique({
      where: { projectId_runId: { projectId, runId } },
    });
    return row ? this.toDomain(row) : null;
  }

  async markExpired(id: string): Promise<StagingPortLease | null> {
    const current = await this.prisma.stagingPortLease.findUnique({ where: { id } });
    if (!current) return null;
    const row = await this.prisma.stagingPortLease.update({
      where: { id },
      data: { status: "expired", portKey: null },
    });
    return this.toDomain(row);
  }

  async markConflict(id: string): Promise<StagingPortLease | null> {
    const current = await this.prisma.stagingPortLease.findUnique({ where: { id } });
    if (!current) return null;
    const row = await this.prisma.stagingPortLease.update({
      where: { id },
      data: { status: "conflict" },
    });
    return this.toDomain(row);
  }

  async release(
    projectId: string,
    runId: string,
    options: ReleaseStagingLeaseOptions = {},
  ): Promise<{ ok: boolean; lease: StagingPortLease | null; reason: string | null }> {
    const current = await this.prisma.stagingPortLease.findUnique({
      where: { projectId_runId: { projectId, runId } },
    });
    if (!current) return { ok: false, lease: null, reason: "lease não encontrado" };
    const status = current.status as StagingLeaseStatus;
    if (status === "released") return { ok: true, lease: this.toDomain(current), reason: null };
    if (status === "conflict" && options.allowConflict !== true) {
      return {
        ok: false,
        lease: this.toDomain(current),
        reason: "lease em conflito exige liberação administrativa explícita",
      };
    }

    const row = await this.prisma.stagingPortLease.update({
      where: { id: current.id },
      data: {
        status: "released",
        portKey: null,
        releasedAt: options.now ?? new Date(),
      },
    });
    return { ok: true, lease: this.toDomain(row), reason: null };
  }

  private toDomain(row: {
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
      status: row.status as StagingLeaseStatus,
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
}
