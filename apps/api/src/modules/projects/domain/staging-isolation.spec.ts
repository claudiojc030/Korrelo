import { assessStagingIsolation, isStagingIsolationRequired } from "./staging-isolation";

const sharedFacts = {
  sharesDatabase: true,
  sharesUploads: true,
  sharesNetwork: true,
  sharesEnv: true,
};

describe("staging isolation", () => {
  it("classifica staging real como compartilhado, nunca isolado", () => {
    const result = assessStagingIsolation(sharedFacts);

    expect(result.level).toBe("shared");
    expect(result.isolated).toBe(false);
    expect(result.sharedResources).toEqual(
      expect.arrayContaining(["banco de produção", "volume de uploads", "rede do projeto"]),
    );
    expect(result.writableProductionResources).toEqual(
      expect.arrayContaining(["volume de uploads (gravável)"]),
    );
  });

  it("sem banco ainda continua compartilhado por uploads/rede/env", () => {
    const result = assessStagingIsolation({
      ...sharedFacts,
      sharesDatabase: false,
    });

    expect(result.isolated).toBe(false);
    expect(result.sharedResources).not.toContain("banco de produção");
  });

  it("só é isolado quando nenhum recurso é compartilhado", () => {
    const result = assessStagingIsolation({
      sharesDatabase: false,
      sharesUploads: false,
      sharesNetwork: false,
      sharesEnv: false,
    });

    expect(result.level).toBe("isolated");
    expect(result.isolated).toBe(true);
    expect(result.blocker).toBeNull();
    expect(result.sequentialAllowed).toBe(true);
  });

  it("isolamento exigido bloqueia sequencial quando há compartilhamento", () => {
    const result = assessStagingIsolation(sharedFacts, { isolationRequired: true });

    expect(result.isolationRequired).toBe(true);
    expect(result.sequentialAllowed).toBe(false);
    expect(result.blocker).toContain("isolamento de staging exigido");
  });

  it("sem exigência explícita, sequencial não é bloqueado por isolamento", () => {
    expect(assessStagingIsolation(sharedFacts).sequentialAllowed).toBe(true);
  });

  it("flag de isolamento é OFF por padrão", () => {
    expect(isStagingIsolationRequired({})).toBe(false);
    expect(isStagingIsolationRequired({ KORRELO_STAGING_REQUIRE_ISOLATION: "1" })).toBe(true);
    expect(isStagingIsolationRequired({ KORRELO_STAGING_REQUIRE_ISOLATION: "false" })).toBe(false);
  });
});
