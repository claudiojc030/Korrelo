import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { Project, type DomainSslStatus, type LastDeployStatus } from "../domain/project.entity";
import type { ProjectStatus } from "@korrelo/shared-types";
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

  async findByRepoUrl(repoUrl: string): Promise<Project[]> {
    const rows = await this.prisma.project.findMany({ where: { repoUrl } });
    return rows.map(this.toDomain);
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
        autoDeployEnabled: project.autoDeployEnabled,
        deployBranch: project.deployBranch,
        diskLimitMb: project.diskLimitMb,
        skipStagingTest: project.skipStagingTest,
        memoryLimitMb: project.memoryLimitMb,
        lastDeployStatus: project.lastDeployStatus,
        currentImage: project.currentImage,
        previousImage: project.previousImage,
        healthcheckConfig: project.healthcheckConfig,
        productionMemoryLimitMb: project.productionMemoryLimitMb,
        runtimeSnapshot: project.runtimeSnapshot,
        grandfathered: project.grandfathered,
        grandfatheredAt: project.grandfatheredAt,
        runtimeDriftDetected: project.runtimeDriftDetected,
        runtimeDriftDetails: project.runtimeDriftDetails,
        memoryLimitReductionApproved: project.memoryLimitReductionApproved,
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
        autoDeployEnabled: project.autoDeployEnabled,
        deployBranch: project.deployBranch,
        diskLimitMb: project.diskLimitMb,
        skipStagingTest: project.skipStagingTest,
        memoryLimitMb: project.memoryLimitMb,
        lastDeployStatus: project.lastDeployStatus,
        currentImage: project.currentImage,
        previousImage: project.previousImage,
        healthcheckConfig: project.healthcheckConfig,
        productionMemoryLimitMb: project.productionMemoryLimitMb,
        runtimeSnapshot: project.runtimeSnapshot,
        grandfathered: project.grandfathered,
        grandfatheredAt: project.grandfatheredAt,
        runtimeDriftDetected: project.runtimeDriftDetected,
        runtimeDriftDetails: project.runtimeDriftDetails,
        memoryLimitReductionApproved: project.memoryLimitReductionApproved,
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
    autoDeployEnabled: boolean;
    deployBranch: string;
    diskLimitMb: number | null;
    skipStagingTest: boolean;
    memoryLimitMb: number | null;
    lastDeployStatus: string | null;
    currentImage: string | null;
    previousImage: string | null;
    healthcheckConfig: string | null;
    productionMemoryLimitMb: number | null;
    runtimeSnapshot: string | null;
    grandfathered: boolean;
    grandfatheredAt: Date | null;
    runtimeDriftDetected: boolean;
    runtimeDriftDetails: string | null;
    memoryLimitReductionApproved: boolean;
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
      row.autoDeployEnabled,
      row.deployBranch,
      row.diskLimitMb,
      row.skipStagingTest,
      row.memoryLimitMb,
      (row.lastDeployStatus as LastDeployStatus | null) ?? null,
      row.currentImage,
      row.previousImage,
      row.healthcheckConfig,
      row.productionMemoryLimitMb,
      row.runtimeSnapshot,
      row.grandfathered,
      row.grandfatheredAt,
      row.runtimeDriftDetected,
      row.runtimeDriftDetails,
      row.memoryLimitReductionApproved,
      row.createdAt,
    );
  }
}
