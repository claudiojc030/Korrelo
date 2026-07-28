import type { ProjectStatus } from "@forgedesk/shared-types";

export type DomainSslStatus = "none" | "pending" | "active" | "failed";

export class Project {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly repoUrl: string,
    public readonly detectedStack: string | null,
    public readonly status: ProjectStatus,
    public readonly assignedPort: number | null,
    public readonly containerName: string | null,
    public readonly terminalEnabled: boolean,
    public readonly databaseEnabled: boolean,
    public readonly customDomain: string | null,
    public readonly domainSslStatus: DomainSslStatus,
    public readonly autoDeployEnabled: boolean,
    public readonly deployBranch: string,
    public readonly createdAt: Date,
  ) {}

  static create(name: string, repoUrl: string): Project {
    return new Project(
      crypto.randomUUID(),
      name,
      repoUrl,
      null,
      "detected",
      null,
      null,
      true,
      true,
      null,
      "none",
      false,
      "main",
      new Date(),
    );
  }

  withDetectedStack(detectedStackJson: string): Project {
    return new Project(
      this.id,
      this.name,
      this.repoUrl,
      detectedStackJson,
      "configuring",
      this.assignedPort,
      this.containerName,
      this.terminalEnabled,
      this.databaseEnabled,
      this.customDomain,
      this.domainSslStatus,
      this.autoDeployEnabled,
      this.deployBranch,
      this.createdAt,
    );
  }

  withDeployment(containerName: string, assignedPort: number): Project {
    return new Project(
      this.id,
      this.name,
      this.repoUrl,
      this.detectedStack,
      "running",
      assignedPort,
      containerName,
      this.terminalEnabled,
      this.databaseEnabled,
      this.customDomain,
      this.domainSslStatus,
      this.autoDeployEnabled,
      this.deployBranch,
      this.createdAt,
    );
  }

  withFailedDeployment(): Project {
    return new Project(
      this.id,
      this.name,
      this.repoUrl,
      this.detectedStack,
      "failed",
      this.assignedPort,
      this.containerName,
      this.terminalEnabled,
      this.databaseEnabled,
      this.customDomain,
      this.domainSslStatus,
      this.autoDeployEnabled,
      this.deployBranch,
      this.createdAt,
    );
  }

  withSettings(terminalEnabled: boolean, databaseEnabled: boolean): Project {
    return new Project(
      this.id,
      this.name,
      this.repoUrl,
      this.detectedStack,
      this.status,
      this.assignedPort,
      this.containerName,
      terminalEnabled,
      databaseEnabled,
      this.customDomain,
      this.domainSslStatus,
      this.autoDeployEnabled,
      this.deployBranch,
      this.createdAt,
    );
  }

  withDomain(customDomain: string | null, domainSslStatus: DomainSslStatus): Project {
    return new Project(
      this.id,
      this.name,
      this.repoUrl,
      this.detectedStack,
      this.status,
      this.assignedPort,
      this.containerName,
      this.terminalEnabled,
      this.databaseEnabled,
      customDomain,
      domainSslStatus,
      this.autoDeployEnabled,
      this.deployBranch,
      this.createdAt,
    );
  }

  withAutoDeploy(autoDeployEnabled: boolean, deployBranch: string): Project {
    return new Project(
      this.id,
      this.name,
      this.repoUrl,
      this.detectedStack,
      this.status,
      this.assignedPort,
      this.containerName,
      this.terminalEnabled,
      this.databaseEnabled,
      this.customDomain,
      this.domainSslStatus,
      autoDeployEnabled,
      deployBranch,
      this.createdAt,
    );
  }
}
