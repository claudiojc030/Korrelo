/**
 * STAGING POR PROJETO - teste de ponta a ponta (compose + dry-run).
 *
 * Prova o que o operador precisa ver ANTES de mandar o deploy do Mesatta:
 *  - o container de TESTE recebe o limite configurado (600 MB);
 *  - o container de PRODUÇÃO continua com 1757 MB;
 *  - o container do BANCO (Mongo) não muda;
 *  - o timeout de health customizado (120s) vale só para o staging;
 *  - um projeto sem override (Evolution) continua no automático;
 *  - o dry-run mostra o valor E a origem ("project-override"/"automatic").
 *
 * Nenhum container é tocado: o orquestrador é um fake e o compose é só
 * gerado em memória.
 */

import { DockerComposeFileBuilder } from "../infrastructure/docker-compose-file-builder";
import { computeDeploymentMemoryPlan, type MemoryBudgetConfig } from "../infrastructure/memory-budget";
import { decideStagingHealthTimeout } from "../domain/staging-config";
import { Project } from "../domain/project.entity";
import type { DeployConfig } from "../domain/container-orchestrator";

const CONFIG: MemoryBudgetConfig = {
  hostReserveMb: 512,
  coreReserveMb: 640,
  dockerReserveMb: 256,
  safetyMarginMb: 256,
  minContainerMb: 128,
  maxContainerMb: 1024,
  dbShare: 0.35,
  stagingShare: 0.25,
  nodeHeapRatio: 0.7,
};

const FOUR_GB = 4096;
const MESATTA_PRODUCTION_LIMIT_MB = 1757;
const MONGODB_LIMIT_MB = 879;

function planParams(overrides: Record<string, unknown> = {}) {
  return {
    totalMemMb: FOUR_GB,
    activeProjects: 2,
    observedProductionLimitMb: MESATTA_PRODUCTION_LIMIT_MB,
    adminLimitMb: null,
    isRunning: true,
    isGrandfathered: true,
    adminReductionApproved: false,
    databases: [{ type: "mongodb" as const, observedLimitMb: MONGODB_LIMIT_MB }],
    config: CONFIG,
    ...overrides,
  };
}

function makeDeployConfig(stagingLimitMb: number, databaseLimitMb: number): DeployConfig {
  return {
    projectPath: "/tmp/proj",
    containerName: "korrelo-mesatta-8452004c",
    hostPort: 3000,
    containerPort: 3000,
    memoryLimitMb: MESATTA_PRODUCTION_LIMIT_MB,
    staging: {
      containerName: "korrelo-mesatta-8452004c-staging",
      hostPort: 3001,
      memoryLimitMb: stagingLimitMb,
    },
    databases: [
      {
        type: "mongodb",
        serviceName: "mongo",
        username: "app",
        password: "secret",
        databaseName: "mesatta",
        memoryLimitMb: databaseLimitMb,
        persistent: true,
      },
    ],
    imageName: "korrelo-mesatta-8452004c",
    imageTag: "commit-abc",
    envFilePath: "/tmp/secrets/.env.korrelo",
    projectId: "8452004c",
    deployJobId: "job-1",
    commitSha: "abc",
  };
}

describe("staging por projeto - o que vai para o Docker", () => {
  it("Mesatta com 600 MB: staging 600, produção 1757, Mongo intacto", () => {
    const plan = computeDeploymentMemoryPlan(planParams({ stagingOverrideLimitMb: 600 }));
    const config = makeDeployConfig(plan.stagingLimitMb, plan.databaseLimits[0].limitMb);
    const compose = new DockerComposeFileBuilder().build(config, "Node.js");

    // O container de TESTE recebe o valor configurado.
    expect(config.staging.memoryLimitMb).toBe(600);
    expect(compose).toContain("mem_limit: 600m");
    // A PRODUÇÃO continua com o limite observado.
    expect(config.memoryLimitMb).toBe(MESATTA_PRODUCTION_LIMIT_MB);
    expect(compose).toContain("mem_limit: 1757m");
    // O BANCO não muda.
    expect(config.databases[0].memoryLimitMb).toBe(MONGODB_LIMIT_MB);
    expect(compose).toContain("mem_limit: 879m");
  });

  it("sem override: o valor automático vai para o staging (comportamento atual)", () => {
    const plan = computeDeploymentMemoryPlan(planParams());
    const config = makeDeployConfig(plan.stagingLimitMb, plan.databaseLimits[0].limitMb);
    const compose = new DockerComposeFileBuilder().build(config, "Node.js");

    expect(plan.stagingLimitSource).toBe("automatic");
    expect(config.staging.memoryLimitMb).toBe(plan.stagingLimitMb);
    expect(compose).toContain(`mem_limit: ${plan.stagingLimitMb}m`);
    // A produção segue igual.
    expect(compose).toContain("mem_limit: 1757m");
  });

  it("o override NÃO vaza para o container de produção nem para o banco", () => {
    const semOverride = computeDeploymentMemoryPlan(planParams());
    const comOverride = computeDeploymentMemoryPlan(planParams({ stagingOverrideLimitMb: 600 }));

    // Produção: idêntica.
    expect(comOverride.productionLimitMb).toBe(semOverride.productionLimitMb);
    // Banco: idêntico.
    expect(comOverride.databaseLimits).toEqual(semOverride.databaseLimits);
    // Só o staging muda.
    expect(comOverride.stagingLimitMb).not.toBe(semOverride.stagingLimitMb);
    expect(comOverride.stagingLimitMb).toBe(600);
  });
});

describe("staging por projeto - timeout de health isolado", () => {
  it("120s no staging; a produção continua com 30s", () => {
    const staging = decideStagingHealthTimeout({ overrideSeconds: 120, defaultSeconds: 30 });
    // A espera de health da PRODUÇÃO usa o default, sempre.
    const PRODUCTION_HEALTH_TIMEOUT_MS = 30_000;

    expect(staging.seconds).toBe(120);
    expect(staging.seconds * 1000).toBe(120_000);
    expect(PRODUCTION_HEALTH_TIMEOUT_MS).toBe(30_000);
  });

  it("sem override, o staging continua com 30s", () => {
    const staging = decideStagingHealthTimeout({ overrideSeconds: null, defaultSeconds: 30 });
    expect(staging.seconds).toBe(30);
    expect(staging.applied).toBe(false);
  });
});

describe("staging por projeto - dry-run mostra valor e origem", () => {
  it("o dry-run do Mesatta mostra 600 MB com origem 'project-override'", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PreviewProjectDeployUseCase } = require("./preview-project-deploy.use-case");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ResourcePreflightService } = require("../infrastructure/resource-preflight.service");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { safeHostResourceProvider } = require("../../../infrastructure/host-resources");

    const project = new Project(
      "8452004c-0000-0000-0000-000000000000",
      "Mesatta",
      "https://github.com/exemplo/mesatta.git",
      JSON.stringify({ language: "Node.js", recommendedPort: 3000 }),
      "running",
      3000,
      "korrelo-mesatta-8452004c",
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
      MESATTA_PRODUCTION_LIMIT_MB,
      null,
      true,
      null,
      false,
      null,
      false,
      600, // stagingMemoryLimitMb
      120, // stagingHealthTimeoutSeconds
      new Date(),
    );

    const inspector = async () => ({
      id: "abc123",
      name: "korrelo-mesatta-8452004c",
      image: "korrelo-mesatta-8452004c:commit-antigo",
      startedAt: "2026-10-20T10:00:00.000000000Z",
      restartCount: 0,
      status: "running",
      running: true,
      health: "healthy",
      restartPolicy: "unless-stopped",
      memoryLimitBytes: 1757 * 1024 * 1024,
      memorySwapBytes: 3514 * 1024 * 1024,
      networks: ["korrelo-shared"],
      ports: ["3000/tcp"],
      mounts: [],
    });

    const useCase = new PreviewProjectDeployUseCase(
      { findById: async () => project, findAll: async () => [project] } as any,
      { findAllByProjectId: async () => [] } as any,
      new ResourcePreflightService(safeHostResourceProvider()),
      inspector as never,
    );

    const preview = await useCase.execute(project.id, { commit: "abcdef1234567890" });

    // O valor e a origem.
    expect(preview.staging.memoryLimitMb).toBe(600);
    expect(preview.staging.memoryLimitSource).toBe("project-override");
    expect(preview.staging.memoryLimitApplied).toBe(true);
    expect(preview.staging.healthTimeoutSeconds).toBe(120);
    expect(preview.staging.healthTimeoutSource).toBe("project-override");
    expect(preview.staging.healthTimeoutApplied).toBe(true);
    // A produção e o limite de produção seguem intactos.
    expect(preview.limits.productionLimitMb).toBe(MESATTA_PRODUCTION_LIMIT_MB);
    expect(preview.current.productionMemoryLimitMb).toBe(MESATTA_PRODUCTION_LIMIT_MB);
  });

  it("o dry-run de um projeto sem override mostra a origem 'automatic'", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PreviewProjectDeployUseCase } = require("./preview-project-deploy.use-case");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ResourcePreflightService } = require("../infrastructure/resource-preflight.service");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { safeHostResourceProvider } = require("../../../infrastructure/host-resources");

    const project = new Project(
      "f848a858-0000-0000-0000-000000000000",
      "Evolution",
      "https://github.com/exemplo/evolution.git",
      JSON.stringify({ language: "Node.js", recommendedPort: 3000 }),
      "running",
      3010,
      "korrelo-evolution-f848a858",
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
      1757,
      null,
      true,
      null,
      false,
      null,
      false,
      null, // stagingMemoryLimitMb: sem override
      null, // stagingHealthTimeoutSeconds: sem override
      new Date(),
    );

    const inspector = async () => ({
      id: "def456",
      name: "korrelo-evolution-f848a858",
      image: "korrelo-evolution-f848a858:commit-antigo",
      startedAt: "2026-10-20T10:00:00.000000000Z",
      restartCount: 0,
      status: "running",
      running: true,
      health: "healthy",
      restartPolicy: "unless-stopped",
      memoryLimitBytes: 1757 * 1024 * 1024,
      memorySwapBytes: 3514 * 1024 * 1024,
      networks: ["korrelo-shared"],
      ports: ["3010/tcp"],
      mounts: [],
    });

    const useCase = new PreviewProjectDeployUseCase(
      { findById: async () => project, findAll: async () => [project] } as any,
      { findAllByProjectId: async () => [] } as any,
      new ResourcePreflightService(safeHostResourceProvider()),
      inspector as never,
    );

    const preview = await useCase.execute(project.id, { commit: "abcdef1234567890" });

    expect(preview.staging.memoryLimitSource).toBe("automatic");
    expect(preview.staging.memoryLimitApplied).toBe(false);
    expect(preview.staging.healthTimeoutSource).toBe("automatic");
    expect(preview.staging.healthTimeoutSeconds).toBe(30);
    expect(preview.limits.productionLimitMb).toBe(1757);
  });
});
