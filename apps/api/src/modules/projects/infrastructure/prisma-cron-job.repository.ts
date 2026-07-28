import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { CronJob, type CronJobStatus } from "../domain/cron-job.entity";
import type { CronJobRepository } from "../domain/cron-job.repository";

@Injectable()
export class PrismaCronJobRepository implements CronJobRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAllEnabled(): Promise<CronJob[]> {
    const rows = await this.prisma.cronJob.findMany({ where: { enabled: true } });
    return rows.map(this.toDomain);
  }

  async findByProjectId(projectId: string): Promise<CronJob[]> {
    const rows = await this.prisma.cronJob.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
    return rows.map(this.toDomain);
  }

  async findById(id: string): Promise<CronJob | null> {
    const row = await this.prisma.cronJob.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  async save(job: CronJob): Promise<CronJob> {
    const row = await this.prisma.cronJob.upsert({
      where: { id: job.id },
      create: {
        id: job.id,
        projectId: job.projectId,
        name: job.name,
        command: job.command,
        schedule: job.schedule,
        enabled: job.enabled,
        lastRunAt: job.lastRunAt,
        lastStatus: job.lastStatus,
        lastOutput: job.lastOutput,
        createdAt: job.createdAt,
      },
      update: {
        name: job.name,
        command: job.command,
        schedule: job.schedule,
        enabled: job.enabled,
        lastRunAt: job.lastRunAt,
        lastStatus: job.lastStatus,
        lastOutput: job.lastOutput,
      },
    });
    return this.toDomain(row);
  }

  async delete(id: string): Promise<void> {
    await this.prisma.cronJob.delete({ where: { id } });
  }

  private toDomain(row: {
    id: string;
    projectId: string;
    name: string;
    command: string;
    schedule: string;
    enabled: boolean;
    lastRunAt: Date | null;
    lastStatus: string | null;
    lastOutput: string | null;
    createdAt: Date;
  }): CronJob {
    return new CronJob(
      row.id,
      row.projectId,
      row.name,
      row.command,
      row.schedule,
      row.enabled,
      row.lastRunAt,
      row.lastStatus as CronJobStatus | null,
      row.lastOutput,
      row.createdAt,
    );
  }
}
