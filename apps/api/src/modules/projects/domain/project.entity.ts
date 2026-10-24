import type { ProjectStatus } from "@korrelo/shared-types";

export type DomainSslStatus = "none" | "pending" | "active" | "failed";

/**
 * Estado do deploy (≠ estado da aplicação).
 *
 * Wave 2: o estado de RUNTIME ("status") e o estado do ÚLTIMO DEPLOY
 * ("lastDeployStatus") são coisas diferentes. Um deploy de staging que falhou
 * NÃO significa que a aplicação em produção caiu - e, enquanto o deploy for
 * tratado como "falha do projeto", o cron, o backup e o terminal param de
 * funcionar numa aplicação que está no ar.
 */
export type LastDeployStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "rolled-back"
  | "canceled"
  | "interrupted"
  /** Produção pode ter ficado incoerente: exige reconciliação antes de novo deploy. */
  | "indeterminate";

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
    public readonly diskLimitMb: number | null,
    public readonly skipStagingTest: boolean,
    public readonly memoryLimitMb: number | null,
    public readonly lastDeployStatus: LastDeployStatus | null,
    public readonly currentImage: string | null,
    public readonly previousImage: string | null,
    public readonly healthcheckConfig: string | null,
    public readonly productionMemoryLimitMb: number | null,
    public readonly runtimeSnapshot: string | null,
    public readonly grandfathered: boolean,
    public readonly grandfatheredAt: Date | null,
    public readonly runtimeDriftDetected: boolean,
    public readonly runtimeDriftDetails: string | null,
    public readonly memoryLimitReductionApproved: boolean,
    public readonly stagingMemoryLimitMb: number | null,
    public readonly stagingHealthTimeoutSeconds: number | null,
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
      null,
      false,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      false,
      null,
      false,
      null,
      false,
      null,
      null,
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
      this.diskLimitMb,
      this.skipStagingTest,
      this.memoryLimitMb,
      this.lastDeployStatus,
      this.currentImage,
      this.previousImage,
      this.healthcheckConfig,
      this.productionMemoryLimitMb,
      this.runtimeSnapshot,
      this.grandfathered,
      this.grandfatheredAt,
      this.runtimeDriftDetected,
      this.runtimeDriftDetails,
      this.memoryLimitReductionApproved,
      this.stagingMemoryLimitMb,
      this.stagingHealthTimeoutSeconds,
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
      this.diskLimitMb,
      this.skipStagingTest,
      this.memoryLimitMb,
      this.lastDeployStatus,
      this.currentImage,
      this.previousImage,
      this.healthcheckConfig,
      this.productionMemoryLimitMb,
      this.runtimeSnapshot,
      this.grandfathered,
      this.grandfatheredAt,
      this.runtimeDriftDetected,
      this.runtimeDriftDetails,
      this.memoryLimitReductionApproved,
      this.stagingMemoryLimitMb,
      this.stagingHealthTimeoutSeconds,
      this.createdAt,
    );
  }

  /**
   * Só é usado quando a APLICAÇÃO realmente parou de funcionar (produção
   * quebrada e sem rollback possível). Falha de deploy que deixou a versão
   * anterior no ar NÃO usa isto.
   */
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
      this.diskLimitMb,
      this.skipStagingTest,
      this.memoryLimitMb,
      this.lastDeployStatus,
      this.currentImage,
      this.previousImage,
      this.healthcheckConfig,
      this.productionMemoryLimitMb,
      this.runtimeSnapshot,
      this.grandfathered,
      this.grandfatheredAt,
      this.runtimeDriftDetected,
      this.runtimeDriftDetails,
      this.memoryLimitReductionApproved,
      this.stagingMemoryLimitMb,
      this.stagingHealthTimeoutSeconds,
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
      this.diskLimitMb,
      this.skipStagingTest,
      this.memoryLimitMb,
      this.lastDeployStatus,
      this.currentImage,
      this.previousImage,
      this.healthcheckConfig,
      this.productionMemoryLimitMb,
      this.runtimeSnapshot,
      this.grandfathered,
      this.grandfatheredAt,
      this.runtimeDriftDetected,
      this.runtimeDriftDetails,
      this.memoryLimitReductionApproved,
      this.stagingMemoryLimitMb,
      this.stagingHealthTimeoutSeconds,
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
      this.diskLimitMb,
      this.skipStagingTest,
      this.memoryLimitMb,
      this.lastDeployStatus,
      this.currentImage,
      this.previousImage,
      this.healthcheckConfig,
      this.productionMemoryLimitMb,
      this.runtimeSnapshot,
      this.grandfathered,
      this.grandfatheredAt,
      this.runtimeDriftDetected,
      this.runtimeDriftDetails,
      this.memoryLimitReductionApproved,
      this.stagingMemoryLimitMb,
      this.stagingHealthTimeoutSeconds,
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
      this.diskLimitMb,
      this.skipStagingTest,
      this.memoryLimitMb,
      this.lastDeployStatus,
      this.currentImage,
      this.previousImage,
      this.healthcheckConfig,
      this.productionMemoryLimitMb,
      this.runtimeSnapshot,
      this.grandfathered,
      this.grandfatheredAt,
      this.runtimeDriftDetected,
      this.runtimeDriftDetails,
      this.memoryLimitReductionApproved,
      this.stagingMemoryLimitMb,
      this.stagingHealthTimeoutSeconds,
      this.createdAt,
    );
  }

  withDiskLimit(diskLimitMb: number | null): Project {
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
      this.autoDeployEnabled,
      this.deployBranch,
      diskLimitMb,
      this.skipStagingTest,
      this.memoryLimitMb,
      this.lastDeployStatus,
      this.currentImage,
      this.previousImage,
      this.healthcheckConfig,
      this.productionMemoryLimitMb,
      this.runtimeSnapshot,
      this.grandfathered,
      this.grandfatheredAt,
      this.runtimeDriftDetected,
      this.runtimeDriftDetails,
      this.memoryLimitReductionApproved,
      this.stagingMemoryLimitMb,
      this.stagingHealthTimeoutSeconds,
      this.createdAt,
    );
  }

  withSkipStagingTest(skipStagingTest: boolean): Project {
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
      this.autoDeployEnabled,
      this.deployBranch,
      this.diskLimitMb,
      skipStagingTest,
      this.memoryLimitMb,
      this.lastDeployStatus,
      this.currentImage,
      this.previousImage,
      this.healthcheckConfig,
      this.productionMemoryLimitMb,
      this.runtimeSnapshot,
      this.grandfathered,
      this.grandfatheredAt,
      this.runtimeDriftDetected,
      this.runtimeDriftDetails,
      this.memoryLimitReductionApproved,
      this.stagingMemoryLimitMb,
      this.stagingHealthTimeoutSeconds,
      this.createdAt,
    );
  }

  withMemoryLimit(memoryLimitMb: number | null): Project {
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
      this.autoDeployEnabled,
      this.deployBranch,
      this.diskLimitMb,
      this.skipStagingTest,
      memoryLimitMb,
      this.lastDeployStatus,
      this.currentImage,
      this.previousImage,
      this.healthcheckConfig,
      this.productionMemoryLimitMb,
      this.runtimeSnapshot,
      this.grandfathered,
      this.grandfatheredAt,
      this.runtimeDriftDetected,
      this.runtimeDriftDetails,
      this.memoryLimitReductionApproved,
      this.stagingMemoryLimitMb,
      this.stagingHealthTimeoutSeconds,
      this.createdAt,
    );
  }

  /** Estado do último deploy (independente do estado de runtime). */
  withLastDeployStatus(lastDeployStatus: LastDeployStatus): Project {
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
      this.autoDeployEnabled,
      this.deployBranch,
      this.diskLimitMb,
      this.skipStagingTest,
      this.memoryLimitMb,
      lastDeployStatus,
      this.currentImage,
      this.previousImage,
      this.healthcheckConfig,
      this.productionMemoryLimitMb,
      this.runtimeSnapshot,
      this.grandfathered,
      this.grandfatheredAt,
      this.runtimeDriftDetected,
      this.runtimeDriftDetails,
      this.memoryLimitReductionApproved,
      this.stagingMemoryLimitMb,
      this.stagingHealthTimeoutSeconds,
      this.createdAt,
    );
  }

  /** Imagem em produção e imagem anterior (usada no rollback). */
  withImages(currentImage: string | null, previousImage: string | null): Project {
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
      this.autoDeployEnabled,
      this.deployBranch,
      this.diskLimitMb,
      this.skipStagingTest,
      this.memoryLimitMb,
      this.lastDeployStatus,
      currentImage,
      previousImage,
      this.healthcheckConfig,
      this.productionMemoryLimitMb,
      this.runtimeSnapshot,
      this.grandfathered,
      this.grandfatheredAt,
      this.runtimeDriftDetected,
      this.runtimeDriftDetails,
      this.memoryLimitReductionApproved,
      this.stagingMemoryLimitMb,
      this.stagingHealthTimeoutSeconds,
      this.createdAt,
    );
  }

  /** Configuração de healthcheck Docker (JSON serializado). */
  withHealthcheckConfig(healthcheckConfig: string | null): Project {
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
      this.autoDeployEnabled,
      this.deployBranch,
      this.diskLimitMb,
      this.skipStagingTest,
      this.memoryLimitMb,
      this.lastDeployStatus,
      this.currentImage,
      this.previousImage,
      healthcheckConfig,
      this.productionMemoryLimitMb,
      this.runtimeSnapshot,
      this.grandfathered,
      this.grandfatheredAt,
      this.runtimeDriftDetected,
      this.runtimeDriftDetails,
      this.memoryLimitReductionApproved,
      this.stagingMemoryLimitMb,
      this.stagingHealthTimeoutSeconds,
      this.createdAt,
    );
  }

  /**
   * Autorização explícita do admin para REDUZIR o limite de memória de um
   * projeto em execução. Sem ela, a redução é ignorada.
   */
  withMemoryLimitReductionApproved(approved: boolean): Project {
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
      this.autoDeployEnabled,
      this.deployBranch,
      this.diskLimitMb,
      this.skipStagingTest,
      this.memoryLimitMb,
      this.lastDeployStatus,
      this.currentImage,
      this.previousImage,
      this.healthcheckConfig,
      this.productionMemoryLimitMb,
      this.runtimeSnapshot,
      this.grandfathered,
      this.grandfatheredAt,
      this.runtimeDriftDetected,
      this.runtimeDriftDetails,
      approved,
      this.stagingMemoryLimitMb,
      this.stagingHealthTimeoutSeconds,
      this.createdAt,
    );
  }

  /**
   * Wave 2.1: registra o estado de runtime observado no Docker.
   *
   * É só METADADO: nada aqui toca em container, volume, rede ou porta. O
   * objetivo é que o Core saiba o limite real que o container de produção tem
   * hoje (e nunca o reduza sozinho).
   */
  withRuntimeObservation(params: {
    productionMemoryLimitMb: number | null;
    runtimeSnapshot: string | null;
    grandfathered: boolean;
    grandfatheredAt: Date | null;
    runtimeDriftDetected: boolean;
    runtimeDriftDetails: string | null;
  }): Project {
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
      this.autoDeployEnabled,
      this.deployBranch,
      this.diskLimitMb,
      this.skipStagingTest,
      this.memoryLimitMb,
      this.lastDeployStatus,
      this.currentImage,
      this.previousImage,
      this.healthcheckConfig,
      params.productionMemoryLimitMb,
      params.runtimeSnapshot,
      params.grandfathered,
      params.grandfatheredAt,
      params.runtimeDriftDetected,
      params.runtimeDriftDetails,
      this.memoryLimitReductionApproved,
      this.stagingMemoryLimitMb,
      this.stagingHealthTimeoutSeconds,
      this.createdAt,
    );
  }

  /**
   * Configuração de STAGING deste projeto (limite de memória e timeout de
   * health do container de TESTE).
   *
   * Isto NÃO toca em produção: o limite de produção, o limite do banco e a
   * memória de outros projetos seguem exatamente como estavam. O valor só
   * entra no container de teste.
   */
  withStagingConfig(params: {
    stagingMemoryLimitMb: number | null;
    stagingHealthTimeoutSeconds: number | null;
  }): Project {
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
      this.autoDeployEnabled,
      this.deployBranch,
      this.diskLimitMb,
      this.skipStagingTest,
      this.memoryLimitMb,
      this.lastDeployStatus,
      this.currentImage,
      this.previousImage,
      this.healthcheckConfig,
      this.productionMemoryLimitMb,
      this.runtimeSnapshot,
      this.grandfathered,
      this.grandfatheredAt,
      this.runtimeDriftDetected,
      this.runtimeDriftDetails,
      this.memoryLimitReductionApproved,
      params.stagingMemoryLimitMb,
      params.stagingHealthTimeoutSeconds,
      this.createdAt,
    );
  }
}
