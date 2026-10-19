import {
  computeAvailablePoolMb,
  computeNodeHeapMb,
  computeProjectMemoryPlan,
  getMemoryBudgetConfig,
  type MemoryBudgetConfig,
} from "./memory-budget";

/**
 * Orçamento de memória (Wave 2, achado DEP-01).
 *
 * O bug antigo: o app recebia o orçamento INTEIRO da RAM disponível e o
 * banco recebia METADE desse valor por fora - com 1 projeto numa VPS de
 * 4 GB, os limites somavam ~9,2 GB (app 3.696 + staging 3.696 + banco
 * 1.848) numa máquina de 4 GB.
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

describe("memory-budget", () => {
  it("reserva host/core/docker/margem antes de dividir entre os projetos", () => {
    const pool = computeAvailablePoolMb(FOUR_GB, CONFIG);
    expect(pool).toBe(4096 - 512 - 640 - 256 - 256);
    expect(pool).toBe(2432);
  });

  it("1 projeto com banco: app, banco e staging dividem a MESMA fatia", () => {
    const plan = computeProjectMemoryPlan({
      totalMemMb: FOUR_GB,
      activeProjects: 1,
      hasDatabase: true,
      config: CONFIG,
    });

    // Nada recebe "a RAM inteira" e o banco não é somado por fora.
    expect(plan.appLimitMb).toBeLessThan(computeAvailablePoolMb(FOUR_GB, CONFIG));
    expect(plan.dbLimitMb).toBeGreaterThan(0);
    expect(plan.stagingLimitMb).toBeGreaterThan(0);
    // A invariante: app + banco + staging <= a fatia do projeto.
    expect(plan.totalDuringDeployMb).toBeLessThanOrEqual(plan.projectShareMb);
    expect(plan.totalDuringDeployMb).toBeLessThanOrEqual(computeAvailablePoolMb(FOUR_GB, CONFIG));
  });

  it("2 projetos: a soma do pior momento (um em deploy, outro parado) cabe na RAM", () => {
    const pool = computeAvailablePoolMb(FOUR_GB, CONFIG);
    const a = computeProjectMemoryPlan({ totalMemMb: FOUR_GB, activeProjects: 2, hasDatabase: true, config: CONFIG });
    const b = computeProjectMemoryPlan({ totalMemMb: FOUR_GB, activeProjects: 2, hasDatabase: true, config: CONFIG });

    // Durante o deploy de A: A ocupa app+banco+staging; B ocupa app+banco.
    const worstCase = a.totalDuringDeployMb + (b.appLimitMb + b.dbLimitMb);
    expect(worstCase).toBeLessThanOrEqual(pool);
  });

  it("nenhum container passa do teto máximo configurável", () => {
    const plan = computeProjectMemoryPlan({
      totalMemMb: FOUR_GB,
      activeProjects: 1,
      hasDatabase: true,
      // o admin pediu 4 GB pro app: o teto global manda.
      overrideAppLimitMb: 4096,
      config: CONFIG,
    });
    expect(plan.appLimitMb).toBeLessThanOrEqual(CONFIG.maxContainerMb);
    expect(plan.dbLimitMb).toBeLessThanOrEqual(CONFIG.maxContainerMb);
    expect(plan.stagingLimitMb).toBeLessThanOrEqual(CONFIG.maxContainerMb);
  });

  it("sem banco gerenciado, nada é reservado para banco", () => {
    const plan = computeProjectMemoryPlan({
      totalMemMb: FOUR_GB,
      activeProjects: 1,
      hasDatabase: false,
      config: CONFIG,
    });
    expect(plan.dbLimitMb).toBe(0);
    expect(plan.appLimitMb).toBeGreaterThan(0);
  });

  it("o heap do Node nunca é maior que o limite do container", () => {
    expect(computeNodeHeapMb(973, CONFIG)).toBeLessThan(973);
    expect(computeNodeHeapMb(973, CONFIG)).toBeGreaterThan(500);
    // Numa VPS pequena, o heap mínimo continua utilizável.
    expect(computeNodeHeapMb(128, CONFIG)).toBeGreaterThanOrEqual(64);
  });

  it("as reservas e os tetos são configuráveis por ambiente", () => {
    const previous = process.env.KORRELO_MEM_MAX_CONTAINER_MB;
    process.env.KORRELO_MEM_MAX_CONTAINER_MB = "512";
    expect(getMemoryBudgetConfig().maxContainerMb).toBe(512);
    if (previous === undefined) delete process.env.KORRELO_MEM_MAX_CONTAINER_MB;
    else process.env.KORRELO_MEM_MAX_CONTAINER_MB = previous;
  });
});
