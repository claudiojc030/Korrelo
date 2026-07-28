import { Injectable } from "@nestjs/common";
import type { ProjectStatus } from "@forgedesk/shared-types";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { Project, type DomainSslStatus } from "../domain/project.entity";
import type { ProjectRepository } from "../domain/project.repository";

@Injectable()
export class PrismaProjectRepository implements ProjectRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<Project[]> {
    const rows = await this.prisma.project.findMany({ orderBy: { createdAt: "desc" } });
    return rows.map(this.toDomain);
  }

  async findById(id: string): Promise<Project | null> {
    const row = await this.prisma.project.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  async findByCustomDomain(customDomain: string): Promise<Project | null> {
    const row = await this.prisma.project.findUnique({ where: { customDomain } });
    return row ? this.toDomain(row) : null;
  }

  async save(project: Project): Promise<Project> {
    const row = await this.prisma.project.upsert({
      where: { id: project.id },
      create: {
        id: project.id,
        name: project.name,
        repoUrl: project.repoUrl,
        detectedStack: project.detectedStack,
        status: project.status,
        assignedPort: project.assignedPort,
        containerName: project.containerName,
        terminalEnabled: project.terminalEnabled,
        databaseEnabled: project.databaseEnabled,
        customDomain: project.customDomain,
        domainSslStatus: project.domainSslStatus,
        createdAt: project.createdAt,
      },
      update: {
        name: project.name,
        repoUrl: project.repoUrl,
        detectedStack: project.detectedStack,
        status: project.status,
        assignedPort: project.assignedPort,
        containerName: project.containerName,
        terminalEnabled: project.terminalEnabled,
        databaseEnabled: project.databaseEnabled,
        customDomain: project.customDomain,
        domainSslStatus: project.domainSslStatus,
      },
    });
    return this.toDomain(row);
  }

  async delete(id: string): Promise<void> {
    await this.prisma.project.delete({ where: { id } });
  }

  private toDomain(row: {
    id: string;
    name: string;
    repoUrl: string;
    detectedStack: string | null;
    status: string;
    assignedPort: number | null;
    containerName: string | null;
    terminalEnabled: boolean;
    databaseEnabled: boolean;
    customDomain: string | null;
    domainSslStatus: string;
    createdAt: Date;
  }): Project {
    return new Project(
      row.id,
      row.name,
      row.repoUrl,
      row.detectedStack,
      row.status as ProjectStatus,
      row.assignedPort,
      row.containerName,
      row.terminalEnabled,
      row.databaseEnabled,
      row.customDomain,
      row.domainSslStatus as DomainSslStatus,
      row.createdAt,
    );
  }
}
