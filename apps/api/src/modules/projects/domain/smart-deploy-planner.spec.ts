import {
  SMART_DEPLOY_BUILD_ESTIMATE_MB,
  SMART_DEPLOY_SAFETY_MARGIN_MB,
  compareSmartDeployShadow,
  planSmartDeploy,
  type SmartDeployInput,
} from "./smart-deploy-planner";

const COMMIT = "a".repeat(40);

function input(overrides: Partial<SmartDeployInput> = {}): SmartDeployInput {
  return {
    commit: { requestedSha: COMMIT, branchHeadSha: COMMIT },
    host: {
      totalMemMb: 4096,
      memAvailableMb: 2412,
      swapTotalMb: 2048,
      swapFreeMb: 1800,
      diskFreeMb: 20_000,
      load1: 0.4,
      psiSome10: 0.1,
      psiFull10: 0,
    },
    production: { running: true, limitMb: 1757, usageMb: 324 },
    history: {
      samples: 720,
      confidence: "high",
      sampledPeakMb: 380,
      cgroupPeakMb: 615,
    },
    profiles: { build: null, staging: null },
    estimates: { buildMb: 1024, stagingMb: 768 },
    queue: {
      runningDeploy: false,
      queuedDeploys: 0,
      activeBuilds: 0,
      selfUpdateRunning: false,
      workerDraining: false,
      attemptsUsed: 0,
      maxAttempts: 5,
    },
    images: {
      exactCommitImageExists: false,
      imageDigestVerified: false,
      prebuiltStagingValidated: false,
    },
    requirements: {
      requiresStaging: true,
      requiresZeroDowntime: false,
      productionMustKeepRunning: true,
      skipStagingConfigured: false,
    },
    capabilities: { phaseBoundaryRecheck: true, prebuiltPromotion: true },
    ...overrides,
  };
}

describe("smart deploy planner", () => {
  it("4 GB: separa build e staging e libera o deploy que o cálculo somado bloqueava", () => {
    const decision = planSmartDeploy(input());

    expect(decision.action).toBe("proceed");
    expect(decision.strategy).toBe("local-build-sequential");
    expect(decision.comparison.conservativeRequiredMb).toBe(2457);
    expect(decision.requiredMb).toBeLessThan(decision.comparison.conservativeRequiredMb!);
    expect(decision.comparison.moreConservative).toBe(false);
    expect(decision.phases.map((phase) => phase.name)).toEqual([
      "build",
      "staging",
      "promotion",
    ]);
  });

  it("sem capacidade de reavaliar entre fases, mantém a política somada e espera", () => {
    const decision = planSmartDeploy(
      input({ capabilities: { phaseBoundaryRecheck: false, prebuiltPromotion: true } }),
    );

    expect(decision.action).toBe("wait");
    expect(decision.strategy).toBe("wait");
    expect(decision.requiredMb).toBe(2457);
    expect(decision.shortfallMb).toBe(45);
  });

  it("1 GB: recusa fisicamente, sem simular sucesso", () => {
    const decision = planSmartDeploy(
      input({
        host: { ...input().host, totalMemMb: 1024, memAvailableMb: 700 },
      }),
    );

    expect(decision.action).toBe("refuse");
    expect(decision.strategy).toBe("insufficient");
    expect(decision.reasons.join(" ")).toContain("abaixo do piso");
  });

  it("2 GB: não prossegue quando a memória disponível não cabe", () => {
    const decision = planSmartDeploy(
      input({
        host: { ...input().host, totalMemMb: 2048, memAvailableMb: 900 },
        production: { running: true, limitMb: 1024, usageMb: 400 },
      }),
    );

    expect(decision.action).not.toBe("proceed");
    expect(["wait", "insufficient"]).toContain(decision.strategy);
  });

  it("8 GB: prossegue com folga", () => {
    const decision = planSmartDeploy(
      input({ host: { ...input().host, totalMemMb: 8192, memAvailableMb: 7000 } }),
    );

    expect(decision.action).toBe("proceed");
    expect(decision.shortfallMb).toBe(0);
  });

  it("VPS sem swap não bloqueia por si só, mas registra o risco", () => {
    const decision = planSmartDeploy(
      input({ host: { ...input().host, swapTotalMb: 0, swapFreeMb: 0 } }),
    );

    expect(decision.action).toBe("proceed");
    expect(decision.unmeasuredRisks.join(" ")).toMatch(/sem swap|swap/i);
  });

  it("swap quase esgotada faz esperar", () => {
    const decision = planSmartDeploy(
      input({ host: { ...input().host, swapFreeMb: 100 } }),
    );

    expect(decision.action).toBe("wait");
    expect(decision.reasons.join(" ")).toContain("swap livre");
  });

  it("disco quase cheio impede o build; imagem pré-construída pequena ainda cabe", () => {
    const noImage = planSmartDeploy(input({ host: { ...input().host, diskFreeMb: 500 } }));
    const withImage = planSmartDeploy(
      input({
        host: { ...input().host, diskFreeMb: 1500 },
        images: {
          exactCommitImageExists: true,
          imageDigestVerified: true,
          prebuiltStagingValidated: true,
        },
      }),
    );

    expect(noImage.action).toBe("refuse");
    expect(withImage.action).toBe("proceed");
    expect(withImage.strategy).toBe("prebuilt-image");
  });

  it("PSI alto faz esperar sem tocar na produção", () => {
    const decision = planSmartDeploy(
      input({ host: { ...input().host, psiSome10: 2.5 } }),
    );

    expect(decision.action).toBe("wait");
    expect(decision.reasons.join(" ")).toContain("PSI some");
  });

  it("pico curto de consumo da produção reduz o headroom e aumenta o requisito", () => {
    const lowUsage = planSmartDeploy(
      input({ production: { running: true, limitMb: 1757, usageMb: 300 } }),
    );
    const highUsage = planSmartDeploy(
      input({ production: { running: true, limitMb: 1757, usageMb: 1200 } }),
    );

    expect(lowUsage.phases.find((phase) => phase.name === "build")!.requiredMb).toBeGreaterThan(
      highUsage.phases.find((phase) => phase.name === "build")!.requiredMb,
    );
  });

  it("build maior que o orçamento não é aceito como sucesso", () => {
    const decision = planSmartDeploy(
      input({ estimates: { buildMb: 3200, stagingMb: 512 } }),
    );

    expect(decision.action).not.toBe("proceed");
  });

  it("staging maior que o orçamento não é aceito como sucesso", () => {
    const decision = planSmartDeploy(
      input({ estimates: { buildMb: 1024, stagingMb: 3200 } }),
    );

    expect(decision.action).not.toBe("proceed");
  });

  it("imagem pré-construída compatível é a estratégia de menor consumo", () => {
    const decision = planSmartDeploy(
      input({
        images: {
          exactCommitImageExists: true,
          imageDigestVerified: true,
          prebuiltStagingValidated: true,
        },
      }),
    );

    expect(decision.action).toBe("proceed");
    expect(decision.strategy).toBe("prebuilt-image");
    expect(decision.requiredMb).toBe(2013);
    expect(decision.phases.map((phase) => phase.name)).toEqual(["promotion"]);
  });

  it("tag existente sem digest/labels verificados NÃO vira imagem pré-construída", () => {
    const decision = planSmartDeploy(
      input({
        images: {
          exactCommitImageExists: true,
          imageDigestVerified: false,
          prebuiltStagingValidated: true,
        },
      }),
    );

    expect(decision.strategy).not.toBe("prebuilt-image");
    expect(decision.reasons.concat(decision.evidence).join(" ")).not.toContain(
      "imagem do commit já construída",
    );
  });

  it("sem perfil medido, usa estimativa e declara o risco", () => {
    const decision = planSmartDeploy(input());

    expect(decision.action).toBe("proceed");
    expect(decision.evidence.join(" ")).not.toContain("pico de build medido");
    expect(decision.unmeasuredRisks.join(" ")).toContain("sem perfil medido");
    expect(decision.phases.find((phase) => phase.name === "build")?.evidence).toBe("estimate");
  });

  it("com perfil válido, registra evidência medida", () => {
    const decision = planSmartDeploy(
      input({
        profiles: {
          build: { valid: true, peakMb: 900, confidence: "high" },
          staging: { valid: true, peakMb: 400, confidence: "high" },
        },
      }),
    );

    expect(decision.phases.find((phase) => phase.name === "build")?.evidence).toBe("measured");
    expect(decision.phases.find((phase) => phase.name === "staging")?.evidence).toBe("measured");
  });

  it("deploy concorrente faz esperar, preservando o commit fixado", () => {
    const decision = planSmartDeploy(
      input({ queue: { ...input().queue, runningDeploy: true } }),
    );

    expect(decision.action).toBe("wait");
    expect(decision.commitSha).toBe(COMMIT);
    expect(decision.reasons.join(" ")).toContain("serial");
  });

  it("restart durante a fila sem métricas não inventa sucesso", () => {
    const decision = planSmartDeploy(
      input({ host: { ...input().host, memAvailableMb: null } }),
    );

    expect(decision.action).toBe("wait");
    expect(decision.commitSha).toBe(COMMIT);
    expect(decision.reasons.join(" ")).toContain("MemAvailable");
  });

  it("promoção falha com rollback não confirmado exige reconciliação", () => {
    const decision = planSmartDeploy(
      input({ lastAttempt: { promotionFailed: true, rollbackConfirmed: false } }),
    );

    expect(decision.action).toBe("refuse");
    expect(decision.strategy).toBe("insufficient");
    expect(decision.reasons.join(" ")).toContain("reconcilie");
  });

  it("commit não fixado é recusado", () => {
    const decision = planSmartDeploy(
      input({ commit: { requestedSha: null } }),
    );

    expect(decision.action).toBe("refuse");
    expect(decision.commitSha).toBeNull();
    expect(decision.reasons.join(" ")).toContain("commit não está fixado");
  });

  it("tentativas esgotadas sem recursos viram insuficiência, não espera infinita", () => {
    const decision = planSmartDeploy(
      input({
        host: { ...input().host, memAvailableMb: 1200 },
        queue: { ...input().queue, attemptsUsed: 5, maxAttempts: 5 },
        capabilities: { phaseBoundaryRecheck: false, prebuiltPromotion: true },
      }),
    );

    expect(decision.action).toBe("refuse");
    expect(decision.strategy).toBe("insufficient");
    expect(decision.reasons.join(" ")).toContain("tentativas");
  });

  it("comparação sombra devolve a diferença sem alterar a decisão", () => {
    const shadow = compareSmartDeployShadow(input());

    expect(shadow.decision.action).toBe("proceed");
    expect(shadow.comparison.conservativeRequiredMb).toBe(2457);
    expect(shadow.comparison.plannerRequiredMb).toBe(shadow.decision.requiredMb);
    expect(shadow.comparison.savingMb).toBe(
      shadow.comparison.conservativeRequiredMb! - shadow.comparison.plannerRequiredMb!,
    );
  });

  it("produção sem limite conhecido espera em vez de adivinhar", () => {
    const decision = planSmartDeploy(
      input({ production: { running: true, limitMb: null, usageMb: 300 } }),
    );

    expect(decision.action).toBe("wait");
    expect(decision.reasons.join(" ")).toContain("limite de produção desconhecido");
  });

  it("sem staging exigido, o build pode ser a única fase de memória", () => {
    const decision = planSmartDeploy(
      input({
        requirements: {
          requiresStaging: false,
          requiresZeroDowntime: false,
          productionMustKeepRunning: true,
          skipStagingConfigured: true,
        },
      }),
    );

    expect(decision.action).toBe("proceed");
    expect(decision.phases.map((phase) => phase.name)).not.toContain("staging");
    expect(decision.comparison.conservativeRequiredMb).toBe(1689);
  });

  it("nunca usa menos que a margem e o piso de segurança", () => {
    const decision = planSmartDeploy(
      input({
        host: { ...input().host, memAvailableMb: 1200, totalMemMb: 2048 },
        production: { running: false, limitMb: null, usageMb: null },
        estimates: { buildMb: 64, stagingMb: 64 },
      }),
    );

    for (const phase of decision.phases) {
      expect(phase.requiredMb).toBeGreaterThanOrEqual(1200);
      expect(phase.requiredMb).toBeGreaterThanOrEqual(64 + SMART_DEPLOY_SAFETY_MARGIN_MB);
    }
    expect(SMART_DEPLOY_BUILD_ESTIMATE_MB).toBe(1024);
  });
});
