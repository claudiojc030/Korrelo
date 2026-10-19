import {
  computeDatabaseBudgets,
  computeDeploymentMemoryPlan,
  computeEffectiveProductionLimit,
  type MemoryBudgetConfig,
} from "./memory-budget";

/**
 * Grandfathering (Wave 2.1).
 *
 * Cenário real (VPS de 4 GB, 1 vCPU):
 *   Mesatta  → app 1757 MB (uso ~803 MB) + Mongo 879 MB
 *   Evolution → app 1757 MB + Postgres 586 MB + Redis 586 MB
 *
 * A fórmula nova (com 2 projetos) daria ~486 MB para o app. Aplicar isso
 * automaticamente MATARIA o Mesatta (que usa ~803 MB). Por isso:
 * - o limite OBSERVADO no Docker é o piso;
 * - a fórmula nova NUNCA reduz um projeto em execução;
 * - reduzir exige autorização explícita do admin.
 */
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

describe("grandfathering - limite de produção", () => {
  it("projeto existente mantém o limite atual (Mesatta: 1757 MB)", () => {
    const result = computeEffectiveProductionLimit({
      observedLimitMb: 1757,
      adminLimitMb: null,
      calculatedLimitMb: 486,
      isRunning: true,
      isGrandfathered: true,
      config: CONFIG,
    });

    expect(result.effectiveLimitMb).toBe(1757);
    expect(result.source).toBe("observed");
    expect(result.requiresExplicitConfirmation).toBe(false);
  });

  it("a fórmula nova menor NUNCA reduz o limite de um projeto em execução", () => {
    const result = computeEffectiveProductionLimit({
      observedLimitMb: 1757,
      adminLimitMb: null,
      calculatedLimitMb: 486,
      isRunning: true,
      isGrandfathered: true,
      config: CONFIG,
    });

    expect(result.effectiveLimitMb).toBeGreaterThanOrEqual(1757);
  });

  it("projeto NOVO usa a fórmula nova desde o começo", () => {
    const result = computeEffectiveProductionLimit({
      observedLimitMb: null,
      adminLimitMb: null,
      calculatedLimitMb: 486,
      isRunning: false,
      isGrandfathered: false,
      config: CONFIG,
    });

    expect(result.effectiveLimitMb).toBe(486);
    expect(result.source).toBe("calculated");
  });

  it("admin pode AUMENTAR o limite de um projeto existente", () => {
    const result = computeEffectiveProductionLimit({
      observedLimitMb: 500,
      adminLimitMb: 900,
      calculatedLimitMb: 486,
      isRunning: true,
      isGrandfathered: true,
      config: CONFIG,
    });

    expect(result.effectiveLimitMb).toBe(900);
    expect(result.source).toBe("admin");
    expect(result.requiresExplicitConfirmation).toBe(false);
  });

  it("admin que DIMINUI o limite de um projeto em execução precisa de confirmação explícita", () => {
    const result = computeEffectiveProductionLimit({
      observedLimitMb: 1757,
      adminLimitMb: 486,
      calculatedLimitMb: 486,
      isRunning: true,
      isGrandfathered: true,
      config: CONFIG,
    });

    // Sem autorização: o limite atual é mantido e a redução é sinalizada.
    expect(result.effectiveLimitMb).toBe(1757);
    expect(result.requiresExplicitConfirmation).toBe(true);
    expect(result.note).toContain("confirmação explícita");
  });

  it("com a autorização explícita, a redução passa a valer", () => {
    const result = computeEffectiveProductionLimit({
      observedLimitMb: 1757,
      adminLimitMb: 486,
      calculatedLimitMb: 486,
      isRunning: true,
      isGrandfathered: true,
      adminReductionApproved: true,
      config: CONFIG,
    });

    expect(result.effectiveLimitMb).toBe(486);
    expect(result.source).toBe("admin");
    expect(result.requiresExplicitConfirmation).toBe(false);
  });
});

describe("grandfathering - bancos", () => {
  it("Mongo do Mesatta (879 MB) é preservado, mesmo com budget menor", () => {
    const result = computeDatabaseBudgets({
      totalBudgetMb: 426,
      databases: [{ type: "mongodb", observedLimitMb: 879 }],
      config: CONFIG,
    });

    expect(result.limits[0].limitMb).toBe(879);
    expect(result.limits[0].preserved).toBe(true);
    // O estouro do budget é REPORTADO (overcommit antigo), não corrigido.
    expect(result.overCommitted).toBe(true);
  });

  it("Evolution preserva Postgres (586 MB) e Redis (586 MB)", () => {
    const result = computeDatabaseBudgets({
      totalBudgetMb: 426,
      databases: [
        { type: "postgres", observedLimitMb: 586 },
        { type: "redis", observedLimitMb: 586 },
      ],
      config: CONFIG,
    });

    expect(result.limits.every((l) => l.preserved)).toBe(true);
    expect(result.totalMb).toBe(1172);
  });

  it("multi-database respeita o budget TOTAL (600 MB → 450 Postgres + 150 Redis)", () => {
    const result = computeDatabaseBudgets({
      totalBudgetMb: 600,
      databases: [{ type: "postgres" }, { type: "redis" }],
      config: CONFIG,
    });

    const postgres = result.limits.find((l) => l.type === "postgres");
    const redis = result.limits.find((l) => l.type === "redis");

    expect(postgres?.limitMb).toBe(450);
    expect(redis?.limitMb).toBe(150);
    // O ponto principal: a SOMA respeita o budget.
    expect(result.totalMb).toBeLessThanOrEqual(600);
  });

  it("um banco só recebe o budget inteiro", () => {
    const result = computeDatabaseBudgets({
      totalBudgetMb: 600,
      databases: [{ type: "mongodb" }],
      config: CONFIG,
    });

    expect(result.limits[0].limitMb).toBe(600);
    expect(result.totalMb).toBe(600);
  });
});

describe("grandfathering - plano de deploy (fonte única)", () => {
  it("Mesatta: plano mantém 1757 MB de produção e 879 MB do Mongo", () => {
    const plan = computeDeploymentMemoryPlan({
      totalMemMb: FOUR_GB,
      activeProjects: 2,
      observedProductionLimitMb: 1757,
      adminLimitMb: null,
      isRunning: true,
      isGrandfathered: true,
      databases: [{ type: "mongodb", observedLimitMb: 879 }],
      config: CONFIG,
    });

    expect(plan.productionLimitMb).toBe(1757);
    expect(plan.databaseLimits[0].limitMb).toBe(879);
    expect(plan.databaseLimits[0].preserved).toBe(true);
    expect(plan.requiresExplicitConfirmation).toBe(false);
  });

  it("projeto novo (sem runtime observado) recebe o limite calculado", () => {
    const plan = computeDeploymentMemoryPlan({
      totalMemMb: FOUR_GB,
      activeProjects: 1,
      observedProductionLimitMb: null,
      adminLimitMb: null,
      isRunning: false,
      isGrandfathered: false,
      databases: [],
      config: CONFIG,
    });

    // 2432 de fatia: app = share - staging - banco = 1824, limitado pelo teto
    // máximo por container (1024 MB).
    expect(plan.productionLimitMb).toBe(1024);
    expect(plan.effective.grandfathered).toBe(false);
  });
});
