import {
  DEFAULT_BUILD_DISK_ESTIMATE_MB,
  DEFAULT_BUILD_DISK_RESERVE_MB,
  DEFAULT_BUILD_DISK_SAFETY_MB,
  evaluateBuildDiskPolicy,
  readBuildDiskPolicy,
} from "./build-disk-policy";

const DEFAULT_REQUIRED =
  DEFAULT_BUILD_DISK_RESERVE_MB + DEFAULT_BUILD_DISK_ESTIMATE_MB + DEFAULT_BUILD_DISK_SAFETY_MB;

describe("build disk policy", () => {
  it("exige reserva + estimativa conservadora + margem", () => {
    expect(DEFAULT_REQUIRED).toBe(9216);
    const decision = evaluateBuildDiskPolicy({ freeMb: DEFAULT_REQUIRED });
    expect(decision.ok).toBe(true);
    expect(decision.requiredMb).toBe(DEFAULT_REQUIRED);
    expect(decision.estimateSource).toBe("default");
  });

  it("bloqueia um byte abaixo do requisito", () => {
    const decision = evaluateBuildDiskPolicy({ freeMb: DEFAULT_REQUIRED - 1 });
    expect(decision.ok).toBe(false);
    expect(decision.blockedBy).toBe("insufficient");
    expect(decision.reason).toContain("disco livre insuficiente");
    expect(decision.reason).toContain("9216 MB");
  });

  it("medição indisponível bloqueia (não presume folga)", () => {
    const decision = evaluateBuildDiskPolicy({ freeMb: null });
    expect(decision.ok).toBe(false);
    expect(decision.blockedBy).toBe("disk_unknown");
  });

  it("usa histórico confiável quando fornecido", () => {
    const decision = evaluateBuildDiskPolicy({ freeMb: 8000, historicalEstimateMb: 2000 });
    expect(decision.requiredMb).toBe(4096 + 2000 + 1024);
    expect(decision.estimateSource).toBe("history");
  });

  it("override explícito substitui só a estimativa e mantém reserva/margem", () => {
    const decision = evaluateBuildDiskPolicy({ freeMb: 2500, explicitRequiredMb: 2000 });
    expect(decision.ok).toBe(false);
    expect(decision.requiredMb).toBe(4096 + 2000 + 1024);
    expect(decision.estimateSource).toBe("override");
    const ok = evaluateBuildDiskPolicy({ freeMb: 7200, explicitRequiredMb: 2000 });
    expect(ok.ok).toBe(true);
  });

  it("respeita variáveis de ambiente documentadas", () => {
    const policy = readBuildDiskPolicy({
      KORRELO_BUILD_DISK_RESERVE_MB: "5000",
      KORRELO_BUILD_DISK_ESTIMATE_MB: "3000",
      KORRELO_BUILD_DISK_SAFETY_MB: "500",
    } as NodeJS.ProcessEnv);
    const decision = evaluateBuildDiskPolicy({ freeMb: 8500, policy });
    expect(decision.requiredMb).toBe(8500);
    expect(decision.ok).toBe(true);
  });

  it("medição negativa/inválida é tratada como indisponível", () => {
    const decision = evaluateBuildDiskPolicy({ freeMb: Number.NaN });
    expect(decision.ok).toBe(false);
    expect(decision.blockedBy).toBe("disk_unknown");
  });
});
