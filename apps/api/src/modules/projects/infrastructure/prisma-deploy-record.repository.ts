import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { DeployRecord, type DeployStatus, type DeployTrigger } from "../domain/deploy-record.entity";
import type { DeployRecordRepository } from "../domain/deploy-record.repository";

@Injectable()
export class PrismaDeployRecordRepository implements DeployRecordRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByProjectId(projectId: string, limit: number): Promise<DeployRecord[]> {
    const rows = await this.prisma.deployRecord.findMany({
      where: { projectId },
      orderBy: { startedAt: "desc" },
      take: limit,
    });
    return rows.map(this.toDomain);
  }

  async save(record: DeployRecord): Promise<DeployRecord> {
    const row = await this.prisma.deployRecord.upsert({
      where: { id: record.id },
      create: {
        id: record.id,
        projectId: record.projectId,
        status: record.status,
        triggeredBy: record.triggeredBy,
        errorMessage: record.errorMessage,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
      },
      update: {
        status: record.status,
        errorMessage: record.errorMessage,
        finishedAt: record.finishedAt,
      },
    });
    return this.toDomain(row);
  }

  private toDomain(row: {
    id: string;
    projectId: string;
    status: string;
    triggeredBy: string;
    errorMessage: string | null;
    startedAt: Date;
    finishedAt: Date | null;
  }): DeployRecord {
    return new DeployRecord(
      row.id,
      row.projectId,
      row.status as DeployStatus,
      row.triggeredBy as DeployTrigger,
      row.errorMessage,
      row.startedAt,
      row.finishedAt,
    );
  }
}
