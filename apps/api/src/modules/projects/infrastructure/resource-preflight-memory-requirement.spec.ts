import { runCommand } from "../../../infrastructure/command-runner";
import {
  computeBuildMemoryRequirementMb,
  safeHostResourceProvider,
} from "../../../infrastructure/host-resources";
import { ResourcePreflightService } from "./resource-preflight.service";

// O preflight consulta o disco (`df`): sem mock, o resultado dependeria da
// máquina que roda o Jest.
jest.mock("../../../infrastructure/command-runner", () => ({
  runCommand: jest.fn(),
}));

const mockedRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;

type CommandResult = Awaited<ReturnType<typeof runCommand>>;

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
    durationMs: 2,
    ...overrides,
  };
}

/** "memória disponível: 2500 MB (exigido: 1883 MB)" -> 1883 */
function requiredFrom(reason: string | null): number | null {
  const match = /exigido: (\d+) MB/.exec(reason ?? "");
  return match ? Number(match[1]) : null;
}

/**
 * REQUISITO DE MEMÓRIA DO BUILD SEM DUPLA CONTAGEM.
 *
 * Antes: memRequired = productionLimit + 256 + staging.
 * `MemAvailable` já desconta o consumo atual da produção, então somar o
 * LIMITE inteiro contava esse consumo duas vezes (Mesatta: 1757 + 256 + 600
 * = 2613 com 2500 disponíveis -> bloqueio indevido).
 *
 * Agora: só o HEADROOM (limite - uso atual) entra, e a fila (`check`) e a
 * espera do job (`waitForSafeHost`) usam a MESMA função.
 */
describe("requisito de memória do build (política única)", () => {
  beforeEach(() => {
    mockedRunCommand.mockReset();
    mockedRunCommand.mockImplementation(async (command: string) => {
      if (command === "df") {
        return result({
          stdout:
            "Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 50000000 25000000 25000000 50% /\n",
        });
      }
      return result();
    });
  });

  function makeService(overrides: Parameters<typeof safeHostResourceProvider>[0] = {}) {
    return new ResourcePreflightService(safeHostResourceProvider(overrides));
  }

  const BASE = {
    hostFloorMb: 1200,
    buildRequirementMb: 1024,
    safetyMarginMb: 256,
    stagingReservationMb: 600,
    productionLimitMb: 1757,
  };

  // ------------------------------------------------------------ função pura
  describe("computeBuildMemoryRequirementMb", () => {
    it("caso real do Mesatta: usa o headroom (não o limite inteiro)", () => {
      const requirement = computeBuildMemoryRequirementMb({
        ...BASE,
        productionUsageMb: 730,
      });

      // headroom = 1757 - 730 = 1027; max(1024, 1027) + 256 + 600 = 1883.
      expect(requirement.productionHeadroomMb).toBe(1027);
      expect(requirement.usageKnown).toBe(true);
      expect(requirement.requiredMb).toBe(1883);
      // O valor antigo (limite cheio) NÃO pode voltar.
      expect(requirement.requiredMb).not.toBe(2613);
      expect(requirement.basis).toBe("production-headroom");
    });

    it("produção longe do limite: o headroom cresce junto", () => {
      const lowUsage = computeBuildMemoryRequirementMb({ ...BASE, productionUsageMb: 200 });
      const highUsage = computeBuildMemoryRequirementMb({ ...BASE, productionUsageMb: 1700 });

      expect(lowUsage.productionHeadroomMb).toBe(1557);
      expect(lowUsage.requiredMb).toBe(1557 + 256 + 600);

      // Perto do limite, o headroom encolhe e o requisito do build manda.
      expect(highUsage.productionHeadroomMb).toBe(57);
      expect(highUsage.requiredMb).toBe(1024 + 256 + 600);
      expect(highUsage.basis).toBe("build");
    });

    it("uso maior que o limite: headroom zero, nunca negativo", () => {
      const requirement = computeBuildMemoryRequirementMb({ ...BASE, productionUsageMb: 2000 });

      expect(requirement.productionHeadroomMb).toBe(0);
      expect(requirement.requiredMb).toBe(1024 + 256 + 600);
      expect(requirement.requiredMb).toBeGreaterThan(0);
    });

    it("métrica de uso indisponível: fallback conservador (limite inteiro)", () => {
      const requirement = computeBuildMemoryRequirementMb({ ...BASE, productionUsageMb: null });

      expect(requirement.usageKnown).toBe(false);
      expect(requirement.productionHeadroomMb).toBe(1757);
      // Exatamente o comportamento anterior: nada afrouxou sem medição.
      expect(requirement.requiredMb).toBe(2613);
    });

    it("sem produção (limite 0): sobra o requisito do build", () => {
      const requirement = computeBuildMemoryRequirementMb({
        ...BASE,
        productionLimitMb: 0,
        productionUsageMb: null,
      });

      expect(requirement.requiredMb).toBe(1024 + 256 + 600);
      expect(requirement.productionHeadroomMb).toBe(0);
    });

    it("o piso do host nunca é reduzido", () => {
      const requirement = computeBuildMemoryRequirementMb({
        ...BASE,
        buildRequirementMb: 100,
        safetyMarginMb: 0,
        stagingReservationMb: 0,
        productionUsageMb: 1757,
      });

      expect(requirement.requiredMb).toBe(1200);
      expect(requirement.basis).toBe("host-floor");
    });
  });

  // -------------------------------------------------------- check (fila)
  describe("check()", () => {
    it("aceita o deploy com 2500 MB quando a produção usa 730 (antes bloqueava)", async () => {
      const service = makeService({ memAvailableMb: 2500, containerMemoryUsageMb: 730 });

      const check = await service.check({
        productionLimitMb: 1757,
        productionContainerName: "korrelo-mesatta-8452004c",
        stagingReservationMb: 600,
        dockerReachable: true,
      });

      expect(check.ok).toBe(true);
      expect(check.metrics.requiredHostMemoryMb).toBe(1883);
      expect(check.metrics.productionUsageMb).toBe(730);
      expect(check.metrics.requiredHostMemoryMb).not.toBe(2613);
    });

    it("sem medição de uso, mantém o requisito conservador (2613)", async () => {
      const service = makeService({ memAvailableMb: 2500, containerMemoryUsageMb: null });

      const check = await service.check({
        productionLimitMb: 1757,
        productionContainerName: "korrelo-mesatta-8452004c",
        stagingReservationMb: 600,
        dockerReachable: true,
      });

      expect(check.ok).toBe(false);
      expect(check.metrics.requiredHostMemoryMb).toBe(2613);
      expect(check.metrics.productionUsageMb).toBeNull();
    });

    it("host realmente sem memória continua bloqueando", async () => {
      const service = makeService({ memAvailableMb: 1500, containerMemoryUsageMb: 730 });

      const check = await service.check({
        productionLimitMb: 1757,
        productionContainerName: "korrelo-mesatta-8452004c",
        stagingReservationMb: 600,
        dockerReachable: true,
      });

      expect(check.ok).toBe(false);
      expect(check.reason).toContain("memória disponível");
      expect(requiredFrom(check.reason)).toBe(1883);
    });

    it("PSI / atividade de swap continuam bloqueando mesmo com uso medido", async () => {
      const service = makeService({
        memAvailableMb: 2500,
        containerMemoryUsageMb: 730,
        swapUsedMb: 900,
        swapActivity: { available: true, swapInDelta: 0, swapOutDelta: 900 },
      });

      const check = await service.check({
        productionLimitMb: 1757,
        productionContainerName: "korrelo-mesatta-8452004c",
        stagingReservationMb: 600,
        dockerReachable: true,
      });

      expect(check.ok).toBe(false);
      expect(check.reason).toContain("swap em uso");
    });
  });

  // ------------------------------------------- waitForSafeHost (job)
  describe("waitForSafeHost()", () => {
    function frozenClock(startMs: number) {
      let clock = startMs;
      return {
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms;
        },
        elapsed: () => clock - startMs,
      };
    }

    it("usa a MESMA política do check(): mesmo cenário, mesmo veredito", async () => {
      const service = makeService({ memAvailableMb: 2500, containerMemoryUsageMb: 730 });

      const check = await service.check({
        productionLimitMb: 1757,
        productionContainerName: "korrelo-mesatta-8452004c",
        stagingReservationMb: 600,
        dockerReachable: true,
      });
      const wait = await service.waitForSafeHost({
        productionLimitMb: 1757,
        productionContainerName: "korrelo-mesatta-8452004c",
        stagingReservationMb: 600,
        now: () => 0,
        sleep: async () => undefined,
        log: () => undefined,
      });

      expect(check.ok).toBe(true);
      expect(wait.safe).toBe(true);
    });

    it("mesma política também no bloqueio: o mesmo 'exigido' nos dois caminhos", async () => {
      const service = makeService({ memAvailableMb: 1882, containerMemoryUsageMb: 730 });

      const check = await service.check({
        productionLimitMb: 1757,
        productionContainerName: "korrelo-mesatta-8452004c",
        stagingReservationMb: 600,
        dockerReachable: true,
      });
      const wait = await service.waitForSafeHost({
        timeoutSec: 0,
        productionLimitMb: 1757,
        productionContainerName: "korrelo-mesatta-8452004c",
        stagingReservationMb: 600,
        now: () => 0,
        sleep: async () => undefined,
        log: () => undefined,
      });

      expect(check.ok).toBe(false);
      expect(wait.safe).toBe(false);
      expect(requiredFrom(check.reason)).toBe(1883);
      expect(requiredFrom(wait.reason)).toBe(1883);
    });

    it("o timeout de espera continua 180s (não mudou nesta tarefa)", async () => {
      const service = makeService({ memAvailableMb: 1500, containerMemoryUsageMb: 730 });
      const clock = frozenClock(1_000_000);

      const wait = await service.waitForSafeHost({
        productionLimitMb: 1757,
        productionContainerName: "korrelo-mesatta-8452004c",
        stagingReservationMb: 600,
        now: clock.now,
        sleep: clock.sleep,
        log: () => undefined,
      });

      expect(wait.safe).toBe(false);
      expect(wait.waitedSec).toBe(180);
      // 0,10,...,180 -> 19 tentativas (10s de intervalo).
      expect(wait.attempts).toBe(19);
    });

    it("o guard é SOMENTE LEITURA: nenhum comando de Docker que altere container", async () => {
      const service = makeService({ memAvailableMb: 2500, containerMemoryUsageMb: 730 });

      await service.check({
        productionLimitMb: 1757,
        productionContainerName: "korrelo-mesatta-8452004c",
        stagingReservationMb: 600,
        dockerReachable: true,
      });
      await service.waitForSafeHost({
        productionLimitMb: 1757,
        productionContainerName: "korrelo-mesatta-8452004c",
        stagingReservationMb: 600,
        now: () => 0,
        sleep: async () => undefined,
        log: () => undefined,
      });

      // Único comando externo: `df` (leitura de disco). Nenhum
      // `docker stop/rm/restart/compose`.
      const commands = mockedRunCommand.mock.calls.map((call) => call[0]);
      expect(commands.every((command) => command === "df")).toBe(true);
    });
  });
});
