import { runCommand } from "../../../infrastructure/command-runner";
import { safeHostResourceProvider } from "../../../infrastructure/host-resources";
import { ResourcePreflightService } from "./resource-preflight.service";
import type { ResourceHistoryService } from "./resource-history.service";
import type { ResourceHistorySummary } from "../domain/resource-history";

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
    durationMs: 1,
    ...overrides,
  };
}

const MINUTE = 60_000;

function summary(overrides: Partial<ResourceHistorySummary> = {}): ResourceHistorySummary {
  return {
    samples: 40,
    windowMs: 39 * MINUTE,
    lastSampleAgeMs: MINUTE,
    container: {
      name: "mesatta",
      samples: 40,
      currentMb: 386,
      peakMb: 568,
      averageMb: 400,
      limitMb: 1757,
    },
    host: { minMemAvailableMb: 2300, maxSwapActivityPages: 0, maxPsiFull10: 0 },
    ...overrides,
  };
}

/**
 * FASE B — a sombra NÃO muda a decisão.
 *
 * Cenário real: 2370 MB disponíveis, requisito conservador de 2395 MB
 * (headroom 1371). O deploy continua bloqueado; a sombra apenas mostra que,
 * com o pico observado de 568 MB, a política adaptativa pediria 2048 MB.
 */
describe("ResourcePreflightService - política adaptativa em sombra", () => {
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

  function makeService(historySummary: ResourceHistorySummary | null) {
    const history = {
      summary: () => historySummary,
    } as unknown as ResourceHistoryService;
    return new ResourcePreflightService(
      safeHostResourceProvider({ memAvailableMb: 2370, containerMemoryUsageMb: 386 }),
      history,
    );
  }

  it("continua bloqueando com 2370 < 2394, mas expõe a comparação adaptativa", async () => {
    const service = makeService(summary());

    const check = await service.check({
      productionLimitMb: 1757,
      productionContainerName: "mesatta",
      stagingReservationMb: 768,
      dockerReachable: true,
    });

    expect(check.ok).toBe(false);
    expect(check.metrics.requiredHostMemoryMb).toBe(2395);
    expect(check.metrics.memoryPolicyShadow).toMatchObject({
      basis: "observed-peak",
      requiredMb: 2048,
      conservativeRequiredMb: 2395,
      savedMb: 347,
      confidence: "high",
      simulation: true,
      shadowOnly: true,
      samplingIntervalSeconds: 60,
    });
  });

  it("sem histórico suficiente, a sombra repete o conservador e explica o motivo", async () => {
    const service = makeService(
      summary({
        samples: 2,
        lastSampleAgeMs: 2 * MINUTE,
        container: { ...summary().container!, samples: 2 },
      }),
    );

    const check = await service.check({
      productionLimitMb: 1757,
      productionContainerName: "mesatta",
      stagingReservationMb: 768,
      dockerReachable: true,
    });

    expect(check.ok).toBe(false);
    expect(check.metrics.memoryPolicyShadow?.basis).toBe("conservative-fallback");
    expect(check.metrics.memoryPolicyShadow?.requiredMb).toBe(2395);
    expect(check.metrics.memoryPolicyShadow?.savedMb).toBe(0);
    expect(check.metrics.memoryPolicyShadow?.reason).toBeTruthy();
  });

  it("sem serviço de histórico, não inventa sombra", async () => {
    const service = new ResourcePreflightService(
      safeHostResourceProvider({ memAvailableMb: 2370, containerMemoryUsageMb: 386 }),
    );

    const check = await service.check({
      productionLimitMb: 1757,
      productionContainerName: "mesatta",
      stagingReservationMb: 768,
      dockerReachable: true,
    });

    expect(check.metrics.memoryPolicyShadow).toBeNull();
  });
});
