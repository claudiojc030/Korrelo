/**
 * STAGING POR PROJETO (limite de memória + timeout de health do container
 * de TESTE).
 *
 * Incidente real (Mesatta): a produção usa ~538 MB, mas o container de
 * staging recebeu só 281 MB do rateio automático global, e o Korrelo
 * abortou o deploy depois de 30s sem resposta - o bootstrap do Next numa
 * VPS de 1 vCPU precisa de mais tempo (o healthcheck Docker do Mesatta já
 * tem `start_period: 90s`).
 *
 * A correção é POR PROJETO: aumentar `KORRELO_MEM_STAGING_SHARE` mudaria
 * TODOS os projetos, o que não é aceitável.
 *
 * ESTAS PROPRIEDADES SÃO O QUE ESTÁ SENDO PROVADO:
 *  1. projeto sem override mantém EXATAMENTE o comportamento atual;
 *  2. Mesatta com 600 MB usa 600 MB SOMENTE no staging;
 *  3. a produção continua em 1757 MB;
 *  4. o limite do BANCO não muda;
 *  5. timeout customizado de 120s é usado SOMENTE no staging;
 *  6. Evolution (sem configuração) continua igual;
 *  7. validação conservadora (piso, teto, faixa do timeout).
 */

import { computeDeploymentMemoryPlan, type MemoryBudgetConfig } from "./memory-budget";
import {
  decideStagingHealthTimeout,
  decideStagingMemoryLimit,
  MAX_STAGING_HEALTH_TIMEOUT_SECONDS,
  MIN_STAGING_HEALTH_TIMEOUT_SECONDS,
  MIN_STAGING_MEMORY_LIMIT_MB,
} from "../domain/staging-config";
import { UpdateProjectSettingsUseCase } from "../application/update-project-settings.use-case";
import { Project } from "../domain/project.entity";
import type { ProjectRepository } from "../domain/project.repository";

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
const EVOLUTION_PRODUCTION_LIMIT_MB = 1757;
const MONGODB_LIMIT_MB = 879;

/** Parâmetros de base do plano (idênticos ao que o deploy usa). */
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

describe("staging por projeto - limite de memória do container de TESTE", () => {
  it("1) projeto SEM override mantém exatamente o cálculo automático de hoje", () => {
    const withoutOverride = computeDeploymentMemoryPlan(planParams());
    const withNullOverride = computeDeploymentMemoryPlan(planParams({ stagingOverrideLimitMb: null }));

    expect(withoutOverride.stagingLimitMb).toBe(withNullOverride.stagingLimitMb);
    expect(withoutOverride.stagingLimitSource).toBe("automatic");
    expect(withoutOverride.stagingLimitApplied).toBe(false);
    expect(withoutOverride.stagingLimitNote).toBeNull();
    // O valor automático é o do rateio (nunca mudamos essa conta).
    expect(withoutOverride.stagingLimitMb).toBeLessThan(MESATTA_PRODUCTION_LIMIT_MB);
  });

  it("2) Mesatta com 600 MB usa 600 MB e a produção continua em 1757 MB", () => {
    const plan = computeDeploymentMemoryPlan(planParams({ stagingOverrideLimitMb: 600 }));

    expect(plan.stagingLimitMb).toBe(600);
    expect(plan.stagingLimitSource).toBe("project-override");
    expect(plan.stagingLimitApplied).toBe(true);
    // A PRODUÇÃO não foi tocada.
    expect(plan.productionLimitMb).toBe(MESATTA_PRODUCTION_LIMIT_MB);
  });

  it("3) o limite do BANCO não muda com o override de staging", () => {
    const semOverride = computeDeploymentMemoryPlan(planParams());
    const comOverride = computeDeploymentMemoryPlan(planParams({ stagingOverrideLimitMb: 600 }));

    expect(comOverride.databaseBudgetTotalMb).toBe(semOverride.databaseBudgetTotalMb);
    expect(comOverride.databaseLimits).toEqual(semOverride.databaseLimits);
    // O Mongo continua com o limite observado (879 MB) - preservado.
    expect(comOverride.databaseLimits[0].limitMb).toBe(MONGODB_LIMIT_MB);
    expect(comOverride.databaseLimits[0].preserved).toBe(true);
  });

  it("4) um projeto sem override não é afetado pelo override de outro projeto", () => {
    const mesatta = computeDeploymentMemoryPlan(planParams({ stagingOverrideLimitMb: 600 }));
    // O Evolution: mesmos host/observado, mas SEM override.
    const evolution = computeDeploymentMemoryPlan(
      planParams({ stagingOverrideLimitMb: null, observedProductionLimitMb: EVOLUTION_PRODUCTION_LIMIT_MB }),
    );

    expect(mesatta.stagingLimitMb).toBe(600);
    expect(evolution.stagingLimitMb).not.toBe(600);
    expect(evolution.stagingLimitSource).toBe("automatic");
    // O Evolution segue com o limite de produção dele.
    expect(evolution.productionLimitMb).toBe(EVOLUTION_PRODUCTION_LIMIT_MB);
  });

  it("5) um override MAIOR que a produção é recusado (o automático é mantido)", () => {
    const plan = computeDeploymentMemoryPlan(planParams({ stagingOverrideLimitMb: 4000 }));

    expect(plan.stagingLimitSource).toBe("automatic");
    expect(plan.stagingLimitApplied).toBe(false);
    expect(plan.stagingLimitNote).toContain("maior que o limite de produção");
    // A produção segue intacta.
    expect(plan.productionLimitMb).toBe(MESATTA_PRODUCTION_LIMIT_MB);
  });

  it("6) um override ABAIXO do piso é recusado (o automático é mantido)", () => {
    const plan = computeDeploymentMemoryPlan(planParams({ stagingOverrideLimitMb: 64 }));

    expect(plan.stagingLimitSource).toBe("automatic");
    expect(plan.stagingLimitApplied).toBe(false);
    expect(plan.stagingLimitNote).toContain("menor que o mínimo");
    expect(plan.productionLimitMb).toBe(MESATTA_PRODUCTION_LIMIT_MB);
  });
});

describe("staging por projeto - timeout de health", () => {
  it("7) sem override, o default de 30s é mantido", () => {
    const decision = decideStagingHealthTimeout({ overrideSeconds: null, defaultSeconds: 30 });

    expect(decision.seconds).toBe(30);
    expect(decision.source).toBe("automatic");
    expect(decision.applied).toBe(false);
  });

  it("8) timeout customizado de 120s é usado", () => {
    const decision = decideStagingHealthTimeout({ overrideSeconds: 120, defaultSeconds: 30 });

    expect(decision.seconds).toBe(120);
    expect(decision.source).toBe("project-override");
    expect(decision.applied).toBe(true);
  });

  it("9) timeout fora da faixa (10-300s) é recusado e o default fica", () => {
    for (const inválido of [9, 301, 0, -5]) {
      const decision = decideStagingHealthTimeout({ overrideSeconds: inválido, defaultSeconds: 30 });
      expect(decision.seconds).toBe(30);
      expect(decision.applied).toBe(false);
      expect(decision.source).toBe("automatic");
    }
    // Os extremos da faixa são aceitos.
    expect(decideStagingHealthTimeout({ overrideSeconds: MIN_STAGING_HEALTH_TIMEOUT_SECONDS, defaultSeconds: 30 }).applied).toBe(true);
    expect(decideStagingHealthTimeout({ overrideSeconds: MAX_STAGING_HEALTH_TIMEOUT_SECONDS, defaultSeconds: 30 }).applied).toBe(true);
  });
});

describe("staging por projeto - decisões isoladas (função pura)", () => {
  it("um override válido devolve o valor e a origem 'project-override'", () => {
    const decision = decideStagingMemoryLimit({
      overrideLimitMb: 600,
      automaticLimitMb: 281,
      productionLimitMb: MESATTA_PRODUCTION_LIMIT_MB,
    });

    expect(decision.stagingLimitMb).toBe(600);
    expect(decision.source).toBe("project-override");
    expect(decision.applied).toBe(true);
    // A nota deixa explícito que a produção não foi alterada.
    expect(decision.note).toContain("NÃO foi alterado");
  });

  it("sem override, o automático é devolvido sem nota", () => {
    const decision = decideStagingMemoryLimit({
      overrideLimitMb: null,
      automaticLimitMb: 281,
      productionLimitMb: MESATTA_PRODUCTION_LIMIT_MB,
    });

    expect(decision.stagingLimitMb).toBe(281);
    expect(decision.source).toBe("automatic");
    expect(decision.applied).toBe(false);
    expect(decision.note).toBeNull();
  });
});

describe("staging por projeto - validação na API de settings", () => {
  function makeRepository(project: Project): ProjectRepository & { saved: Project[] } {
    const saved: Project[] = [];
    return {
      saved,
      findById: async () => project,
      findAll: async () => [project],
      findByCustomDomain: async () => null,
      findByRepoUrl: async () => [],
      save: async (value: Project) => {
        saved.push(value);
        return value;
      },
      delete: async () => undefined,
    } as unknown as ProjectRepository & { saved: Project[] };
  }

  function makeProject(overrides: {
    stagingMemoryLimitMb?: number | null;
    stagingHealthTimeoutSeconds?: number | null;
    productionMemoryLimitMb?: number | null;
  }): Project {
    return new Project(
      "mesatta-1",
      "Mesatta",
      "https://github.com/exemplo/mesatta.git",
      JSON.stringify({ language: "Node.js", recommendedPort: 3000 }),
      "running",
      3000,
      "korrelo-mesatta-1",
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
      overrides.productionMemoryLimitMb ?? MESATTA_PRODUCTION_LIMIT_MB,
      null,
      true,
      null,
      false,
      null,
      false,
      overrides.stagingMemoryLimitMb ?? null,
      overrides.stagingHealthTimeoutSeconds ?? null,
      new Date(),
    );
  }

  it("10) aceita 600 MB de staging e 120s de timeout", async () => {
    const repository = makeRepository(makeProject({}));
    const useCase = new UpdateProjectSettingsUseCase(repository);

    const updated = await useCase.execute("mesatta-1", {
      stagingMemoryLimitMb: 600,
      stagingHealthTimeoutSeconds: 120,
    });

    expect(updated.stagingMemoryLimitMb).toBe(600);
    expect(updated.stagingHealthTimeoutSeconds).toBe(120);
    // A produção NÃO foi tocada por essa configuração.
    expect(updated.productionMemoryLimitMb).toBe(MESATTA_PRODUCTION_LIMIT_MB);
  });

  it("11) RECUSA limite de staging abaixo do piso de 128 MB", async () => {
    const repository = makeRepository(makeProject({}));
    const useCase = new UpdateProjectSettingsUseCase(repository);

    await expect(
      useCase.execute("mesatta-1", { stagingMemoryLimitMb: MIN_STAGING_MEMORY_LIMIT_MB - 1 }),
    ).rejects.toThrow(/128 MB/);
    expect(repository.saved).toHaveLength(0);
  });

  it("12) RECUSA limite de staging MAIOR que o limite de produção", async () => {
    const repository = makeRepository(makeProject({}));
    const useCase = new UpdateProjectSettingsUseCase(repository);

    await expect(
      useCase.execute("mesatta-1", { stagingMemoryLimitMb: MESATTA_PRODUCTION_LIMIT_MB + 1 }),
    ).rejects.toThrow(/não pode passar do limite de produção/);
    expect(repository.saved).toHaveLength(0);
  });

  it("13) RECUSA timeout de staging fora de 10-300s", async () => {
    const repository = makeRepository(makeProject({}));
    const useCase = new UpdateProjectSettingsUseCase(repository);

    await expect(
      useCase.execute("mesatta-1", { stagingHealthTimeoutSeconds: MIN_STAGING_HEALTH_TIMEOUT_SECONDS - 1 }),
    ).rejects.toThrow(/entre 10 e 300 segundos/);
    await expect(
      useCase.execute("mesatta-1", { stagingHealthTimeoutSeconds: MAX_STAGING_HEALTH_TIMEOUT_SECONDS + 1 }),
    ).rejects.toThrow(/entre 10 e 300 segundos/);
    expect(repository.saved).toHaveLength(0);
  });

  it("14) null volta ao automático/default sem tocar na produção", async () => {
    const repository = makeRepository(
      makeProject({ stagingMemoryLimitMb: 600, stagingHealthTimeoutSeconds: 120 }),
    );
    const useCase = new UpdateProjectSettingsUseCase(repository);

    const updated = await useCase.execute("mesatta-1", {
      stagingMemoryLimitMb: null,
      stagingHealthTimeoutSeconds: null,
    });

    expect(updated.stagingMemoryLimitMb).toBeNull();
    expect(updated.stagingHealthTimeoutSeconds).toBeNull();
    expect(updated.productionMemoryLimitMb).toBe(MESATTA_PRODUCTION_LIMIT_MB);
  });
});
