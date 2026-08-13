import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import type { ProjectDomainAliasRepository } from "../domain/project-domain-alias.repository";

@Injectable()
export class PrismaProjectDomainAliasRepository implements ProjectDomainAliasRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByProjectId(projectId: string): Promise<string[]> {
    const rows = await this.prisma.projectDomainAlias.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => row.domain);
  }

  async findByDomain(domain: string): Promise<{ projectId: string } | null> {
    const row = await this.prisma.projectDomainAlias.findUnique({ where: { domain } });
    return row ? { projectId: row.projectId } : null;
  }

  async add(projectId: string, domain: string): Promise<void> {
    await this.prisma.projectDomainAlias.create({ data: { projectId, domain } });
  }

  async remove(projectId: string, domain: string): Promise<void> {
    await this.prisma.projectDomainAlias.deleteMany({ where: { projectId, domain } });
  }

  async removeAllByProjectId(projectId: string): Promise<void> {
    await this.prisma.projectDomainAlias.deleteMany({ where: { projectId } });
  }
}
