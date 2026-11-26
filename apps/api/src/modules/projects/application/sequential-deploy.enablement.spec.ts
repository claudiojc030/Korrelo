import {
  describeSequentialBuildMode,
  isSequentialBuildEnabledForProject,
} from "./sequential-deploy.enablement";

const PROJECT = "mesatta-1";

describe("ativação sequencial por projeto", () => {
  it("default absoluto é desligado", () => {
    expect(isSequentialBuildEnabledForProject(PROJECT, {})).toBe(false);
    expect(describeSequentialBuildMode(PROJECT, {}).enabled).toBe(false);
  });

  it("habilita somente o projeto na allowlist", () => {
    const env = { KORRELO_SEQUENTIAL_PROJECTS: `${PROJECT}, outro` };

    expect(isSequentialBuildEnabledForProject(PROJECT, env)).toBe(true);
    expect(isSequentialBuildEnabledForProject("projeto-nao-listado", env)).toBe(false);
  });

  it("ignora espaços e entradas vazias na allowlist", () => {
    const env = { KORRELO_SEQUENTIAL_PROJECTS: ` , ${PROJECT} ,,` };

    expect(isSequentialBuildEnabledForProject(PROJECT, env)).toBe(true);
  });

  it("projeto vazio nunca habilita", () => {
    expect(isSequentialBuildEnabledForProject("", { KORRELO_SEQUENTIAL_PROJECTS: "," })).toBe(false);
    expect(isSequentialBuildEnabledForProject("   ", { KORRELO_SEQUENTIAL_PROJECTS: " " })).toBe(false);
  });

  it("flag global explícita continua opt-in amplo", () => {
    expect(isSequentialBuildEnabledForProject(PROJECT, { KORRELO_SEQUENTIAL_BUILD: "1" })).toBe(true);
    expect(isSequentialBuildEnabledForProject(PROJECT, { KORRELO_SEQUENTIAL_BUILD: "true" })).toBe(true);
  });

  it("kill switch global desliga mesmo com projeto na allowlist", () => {
    const env = {
      KORRELO_SEQUENTIAL_PROJECTS: PROJECT,
      KORRELO_SEQUENTIAL_BUILD: "0",
    };

    expect(isSequentialBuildEnabledForProject(PROJECT, env)).toBe(false);
    expect(describeSequentialBuildMode(PROJECT, env).reason).toContain("globalmente");
  });

  it("projetos não habilitados permanecem no fluxo antigo", () => {
    const env = { KORRELO_SEQUENTIAL_PROJECTS: "outro-projeto" };

    expect(isSequentialBuildEnabledForProject(PROJECT, env)).toBe(false);
    expect(describeSequentialBuildMode(PROJECT, env).reason).toContain("allowlist");
  });

  it("texto de prévia explica o motivo sem expor valores sensíveis", () => {
    expect(describeSequentialBuildMode(PROJECT, { KORRELO_SEQUENTIAL_PROJECTS: PROJECT })).toEqual({
      enabled: true,
      reason: "pipeline sequencial habilitado para este projeto",
    });
  });
});
