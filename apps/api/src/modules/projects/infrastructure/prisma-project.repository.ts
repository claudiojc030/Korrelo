import { Injectable } from "@nestjs/common";
import type { ProjectStatus } from "@forgedesk/shared-types";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { Project } from "../domain/project.entity";
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
        createdAt: project.createdAt,
      },
      update: {
        name: project.name,
        repoUrl: project.repoUrl,
        detectedStack: project.detectedStack,
        status: project.status,
        assignedPort: project.assignedPort,
        containerName: project.containerName,
      },
    });
    return this.toDomain(row);
  }

  private toDomain(row: {
    id: string;
    name: string;
    repoUrl: string;
    detectedStack: string | null;
    status: string;
    assignedPort: number | null;
    containerName: string | null;
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
      row.createdAt,
    );
  }
}
