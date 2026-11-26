import { buildSmartDeployPreview } from "./preview-project-deploy.use-case";
import { assessStagingIsolation } from "../domain/staging-isolation";

const PROJECT = "proj-mesatta";
const SHA = "a".repeat(40);

const sharedIsolation = assessStagingIsolation({
  sharesDatabase: true,
  sharesUploads: true,
  sharesNetwork: true,
  sharesEnv: true,
});

function preview(overrides: Partial<Parameters<typeof buildSmartDeployPreview>[0]> = {}) {
  return buildSmartDeployPreview({
    projectId: PROJECT,
    commit: SHA,
    productionLimitMb: 1757,
    stagingLimitMb: 768,
    requiredHostMemoryMb: 2457,
    availableForBuildMb: 2412,
    memAvailableMb: 2412,
    preflightOk: false,
    preflightReason: "memória livre insuficiente",
    isolation: sharedIsolation,
    ...overrides,
  });
}

describe("prévia Smart Deploy", () => {
  afterEach(() => {
    delete process.env.KORRELO_SEQUENTIAL_PROJECTS;
    delete process.env.KORRELO_SEQUENTIAL_BUILD;
    delete process.env.KORRELO_STAGING_REQUIRE_ISOLATION;
  });

  it("projeto autorizado com commit fixado mostra estratégia sequencial", () => {
    process.env.KORRELO_SEQUENTIAL_PROJECTS = PROJECT;

    const result = preview();

    expect(result.projectAuthorized).toBe(true);
    expect(result.flagEnabled).toBe(true);
    expect(result.commitPinned).toBe(true);
    expect(result.strategy).toBe("sequential");
    expect(result.readyToStart).toBe(false);
  });

  it("projeto não autorizado permanece no fluxo legado", () => {
    process.env.KORRELO_SEQUENTIAL_PROJECTS = "outro";

    const result = preview();

    expect(result.projectAuthorized).toBe(false);
    expect(result.strategy).toBe("legacy");
  });

  it("kill switch global desliga a prévia sequencial", () => {
    process.env.KORRELO_SEQUENTIAL_PROJECTS = PROJECT;
    process.env.KORRELO_SEQUENTIAL_BUILD = "0";

    const result = preview();

    expect(result.strategy).toBe("legacy");
    expect(result.flagReason).toContain("globalmente");
  });

  it("commit curto/ausente não é considerado fixado", () => {
    process.env.KORRELO_SEQUENTIAL_PROJECTS = PROJECT;

    expect(preview({ commit: null }).commitPinned).toBe(false);
    expect(preview({ commit: null }).strategy).toBe("legacy");
    expect(preview({ commit: "abc123" }).strategy).toBe("legacy");
  });

  it("isolamento exigido sem isolamento real bloqueia sequencial", () => {
    process.env.KORRELO_SEQUENTIAL_PROJECTS = PROJECT;
    process.env.KORRELO_STAGING_REQUIRE_ISOLATION = "1";

    const result = preview({
      isolation: assessStagingIsolation(
        { sharesDatabase: true, sharesUploads: true, sharesNetwork: true, sharesEnv: true },
        { isolationRequired: true },
      ),
    });

    expect(result.strategy).toBe("legacy");
    expect(result.isolation.sequentialAllowed).toBe(false);
  });

  it("propaga requisitos, disponibilidade e motivo de espera", () => {
    process.env.KORRELO_SEQUENTIAL_PROJECTS = PROJECT;

    const result = preview();

    expect(result.estimates.requiredHostMemoryMb).toBe(2457);
    expect(result.estimates.availableForBuildMb).toBe(2412);
    expect(result.estimates.productionLimitMb).toBe(1757);
    expect(result.estimates.stagingLimitMb).toBe(768);
    expect(result.waitReasons).toEqual(["memória livre insuficiente"]);
  });

  it("sem falha de recursos não inventa motivo de espera", () => {
    const result = preview({ preflightOk: true, preflightReason: null });
    expect(result.waitReasons).toEqual([]);
  });

  it("nunca afirma que a estratégia está pronta para executar", () => {
    process.env.KORRELO_SEQUENTIAL_PROJECTS = PROJECT;
    const result = preview({ preflightOk: true, preflightReason: null });

    expect(result.readyToStart).toBe(false);
    expect(result.readyReason).toMatch(/prévia somente leitura/);
  });
});
