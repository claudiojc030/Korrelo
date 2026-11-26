import { resolveProjectRuntimeIsolation } from "./project-isolation";

const LAB = "lab-project-1";

describe("isolamento opcional de projeto", () => {
  it("default é desligado", () => {
    const result = resolveProjectRuntimeIsolation(LAB, {});

    expect(result.enabled).toBe(false);
    expect(result.cpus).toBeNull();
    expect(result.pidsLimit).toBeNull();
  });

  it("habilita somente o projeto na allowlist", () => {
    const env = { KORRELO_ISOLATED_PROJECTS: `outro, ${LAB}` };

    expect(resolveProjectRuntimeIsolation(LAB, env).enabled).toBe(true);
    expect(resolveProjectRuntimeIsolation("projeto-comercial", env).enabled).toBe(false);
  });

  it("aplica limites conservadores padrão", () => {
    const result = resolveProjectRuntimeIsolation(LAB, { KORRELO_ISOLATED_PROJECTS: LAB });

    expect(result.cpus).toBe(0.25);
    expect(result.pidsLimit).toBe(64);
    expect(result.reason).toContain("sem rede compartilhada");
  });

  it("respeita limites explícitos e aplica teto", () => {
    const result = resolveProjectRuntimeIsolation(LAB, {
      KORRELO_ISOLATED_PROJECTS: LAB,
      KORRELO_ISOLATED_CPU_LIMIT: "0.5",
      KORRELO_ISOLATED_PIDS_LIMIT: "32",
    });

    expect(result.cpus).toBe(0.5);
    expect(result.pidsLimit).toBe(32);

    const capped = resolveProjectRuntimeIsolation(LAB, {
      KORRELO_ISOLATED_PROJECTS: LAB,
      KORRELO_ISOLATED_CPU_LIMIT: "99",
      KORRELO_ISOLATED_PIDS_LIMIT: "999999",
    });
    expect(capped.cpus).toBe(4);
    expect(capped.pidsLimit).toBe(4096);
  });

  it("valores inválidos caem no default, nunca em zero/ilimitado", () => {
    const result = resolveProjectRuntimeIsolation(LAB, {
      KORRELO_ISOLATED_PROJECTS: LAB,
      KORRELO_ISOLATED_CPU_LIMIT: "0",
      KORRELO_ISOLATED_PIDS_LIMIT: "-5",
    });

    expect(result.cpus).toBe(0.25);
    expect(result.pidsLimit).toBe(64);
  });

  it("projeto vazio nunca habilita", () => {
    expect(resolveProjectRuntimeIsolation("", { KORRELO_ISOLATED_PROJECTS: "," }).enabled).toBe(false);
  });
});
