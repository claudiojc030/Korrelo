import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { DeployJob, type DeployJobStatus, type DeployJobTrigger } from "../domain/deploy-job.entity";
import type { DeployJobRepository } from "../domain/deploy-job.repository";

@Injectable()
export class PrismaDeployJobRepository implements DeployJobRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(job: DeployJob): Promise<DeployJob> {
    const row = await this.prisma.deployJob.create({ data: this.toRow(job) });
    return this.toDomain(row);
  }

  async save(job: DeployJob): Promise<DeployJob> {
    const row = await this.prisma.deployJob.upsert({
      where: { id: job.id },
      create: this.toRow(job),
      update: {
        commitSha: job.commitSha,
        branch: job.branch,
        status: job.status,
        attempt: job.attempt,
        stage: job.stage,
        errorMessage: job.errorMessage,
        log: job.log,
        previousImage: job.previousImage,
        candidateImage: job.candidateImage,
        rollbackAttempted: job.rollbackAttempted,
        rollbackSucceeded: job.rollbackSucceeded,
        imageTag: job.imageTag,
        buildDurationMs: job.buildDurationMs,
        deployDurationMs: job.deployDurationMs,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
      },
    });
    return this.toDomain(row);
  }

  async findById(id: string): Promise<DeployJob | null> {
    const row = await this.prisma.deployJob.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  async findNextQueued(excludeIds: string[] = []): Promise<DeployJob | null> {
    // Ordem FIFO: o job mais antigo da fila vai primeiro. "orderBy" duplo
    // (createdAt + id) dá desempate determinístico quando dois jobs foram
    // criados no mesmo milissegundo.
    const row = await this.prisma.deployJob.findFirst({
      where: {
        status: "queued",
        ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return row ? this.toDomain(row) : null;
  }

  async findOpenByProject(projectId: string): Promise<DeployJob | null> {
    const row = await this.prisma.deployJob.findFirst({
      where: { projectId, status: { in: ["queued", "running"] } },
      orderBy: { createdAt: "asc" },
    });
    return row ? this.toDomain(row) : null;
  }

  async findByProjectAndCommit(projectId: string, commitSha: string): Promise<DeployJob | null> {
    const row = await this.prisma.deployJob.findUnique({
      where: { projectId_commitSha: { projectId, commitSha } },
    });
    return row ? this.toDomain(row) : null;
  }

  async findAllByStatus(status: DeployJobStatus): Promise<DeployJob[]> {
    const rows = await this.prisma.deployJob.findMany({
      where: { status },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(this.toDomain);
  }

  async findLatestByProject(projectId: string): Promise<DeployJob | null> {
    const row = await this.prisma.deployJob.findFirst({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
    return row ? this.toDomain(row) : null;
  }

  async findRecent(limit: number): Promise<DeployJob[]> {
    const rows = await this.prisma.deployJob.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(this.toDomain);
  }

  async countByStatus(status: DeployJobStatus): Promise<number> {
    return this.prisma.deployJob.count({ where: { status } });
  }

  private toRow(job: DeployJob) {
    return {
      id: job.id,
      projectId: job.projectId,
      commitSha: job.commitSha,
      branch: job.branch,
      trigger: job.trigger,
      status: job.status,
      attempt: job.attempt,
      stage: job.stage,
      errorMessage: job.errorMessage,
      log: job.log,
      previousImage: job.previousImage,
      candidateImage: job.candidateImage,
      rollbackAttempted: job.rollbackAttempted,
      rollbackSucceeded: job.rollbackSucceeded,
      imageTag: job.imageTag,
      buildDurationMs: job.buildDurationMs,
      deployDurationMs: job.deployDurationMs,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
  }

  private toDomain(row: {
    id: string;
    projectId: string;
    commitSha: string | null;
    branch: string;
    trigger: string;
    status: string;
    attempt: number;
    stage: string | null;
    errorMessage: string | null;
    log: string;
    previousImage: string | null;
    candidateImage: string | null;
    rollbackAttempted: boolean;
    rollbackSucceeded: boolean;
    imageTag: string | null;
    buildDurationMs: number | null;
    deployDurationMs: number | null;
    createdAt: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
  }): DeployJob {
    return new DeployJob(
      row.id,
      row.projectId,
      row.commitSha,
      row.branch,
      row.trigger as DeployJobTrigger,
      row.status as DeployJobStatus,
      row.attempt,
      (row.stage as DeployJob["stage"]) ?? null,
      row.errorMessage,
      row.log,
      row.previousImage,
      row.candidateImage,
      row.rollbackAttempted,
      row.rollbackSucceeded,
      row.imageTag,
      row.buildDurationMs,
      row.deployDurationMs,
      row.createdAt,
      row.startedAt,
      row.finishedAt,
    );
  }
}
