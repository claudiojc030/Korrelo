import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { MetricSample } from "../domain/metric-sample.entity";
import type { MetricSampleRepository } from "../domain/metric-sample.repository";

@Injectable()
export class PrismaMetricSampleRepository implements MetricSampleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(sample: MetricSample): Promise<MetricSample> {
    const row = await this.prisma.metricSample.create({
      data: {
        id: sample.id,
        cpuPercent: sample.cpuPercent,
        usedMemPercent: sample.usedMemPercent,
        usedDiskPercent: sample.usedDiskPercent,
        capturedAt: sample.capturedAt,
      },
    });
    return this.toDomain(row);
  }

  async findSince(since: Date): Promise<MetricSample[]> {
    const rows = await this.prisma.metricSample.findMany({
      where: { capturedAt: { gte: since } },
      orderBy: { capturedAt: "asc" },
    });
    return rows.map((row) => this.toDomain(row));
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    const result = await this.prisma.metricSample.deleteMany({ where: { capturedAt: { lt: cutoff } } });
    return result.count;
  }

  private toDomain(row: {
    id: string;
    cpuPercent: number;
    usedMemPercent: number;
    usedDiskPercent: number;
    capturedAt: Date;
  }): MetricSample {
    return new MetricSample(row.id, row.cpuPercent, row.usedMemPercent, row.usedDiskPercent, row.capturedAt);
  }
}
