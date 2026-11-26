import {
  SequentialDeployError,
  SequentialDeployRunner,
  isSequentialBuildEnabled,
  sequentialCandidateReference,
  type SequentialPhaseOrchestrator,
  type SequentialPhasePreflight,
} from "./sequential-deploy.runner";
import type { DeployConfig } from "../domain/container-orchestrator";

function config(): DeployConfig {
  return {
    projectPath: "/tmp/proj",
    containerName: "korrelo-mesatta-8452004c",
    hostPort: 3100,
    containerPort: 3000,
    memoryLimitMb: 1757,
    staging: { containerName: "korrelo-mesatta-8452004c-staging", hostPort: 3101, memoryLimitMb: 768 },
    databases: [],
    imageName: "korrelo-mesatta-8452004c",
    imageTag: "commit-aaaaaaabbbbb",
    composeFilePath: "docker-compose.korrelo.job-1.yml",
    composeEnvFilePath: "/tmp/.compose.env",
    commitSha: "a".repeat(40),
  };
}

const IMAGE_ID = `sha256:${"1".repeat(64)}`;
const OTHER_ID = `sha256:${"2".repeat(64)}`;

function harness(options: {
  waits?: Array<{ safe: boolean; reason?: string | null }>;
  buildError?: Error;
  stagingError?: Error;
  imageIds?: Array<string | null>;
  containerIds?: Array<string | null>;
} = {}) {
  const calls: string[] = [];
  const waits = [...(options.waits ?? [{ safe: true }, { safe: true }])];
  const imageIds = [...(options.imageIds ?? [IMAGE_ID, IMAGE_ID])];
  const containerIds = [...(options.containerIds ?? [IMAGE_ID])];
  const orchestrator: SequentialPhaseOrchestrator = {
    buildCandidate: jest.fn(async () => {
      calls.push("build");
      if (options.buildError) throw options.buildError;
      return "build log";
    }),
    startStaging: jest.fn(async () => {
      calls.push("staging");
      if (options.stagingError) throw options.stagingError;
      return "staging log";
    }),
    imageId: jest.fn(async () => {
      calls.push("image");
      return imageIds.length > 0 ? (imageIds.shift() as string | null) : IMAGE_ID;
    }),
    containerImageId: jest.fn(async () => {
      calls.push("container");
      return containerIds.length > 0 ? (containerIds.shift() as string | null) : IMAGE_ID;
    }),
  };
  const preflight: SequentialPhasePreflight = {
    waitForSafeHost: jest.fn(async (_input) => {
      calls.push("wait");
      const next = waits.shift() ?? { safe: true };
      return {
        safe: next.safe,
        reason: next.reason ?? (next.safe ? null : "sem memória"),
        waitedSec: 0,
        attempts: 1,
      };
    }),
  };
  const runner = new SequentialDeployRunner(orchestrator, preflight);
  return { runner, orchestrator, preflight, calls };
}

function input() {
  return {
    config: config(),
    productionLimitMb: 1757,
    productionContainerName: "korrelo-mesatta-8452004c",
    buildRequirementMb: 1024,
    stagingRequirementMb: 768,
    log: jest.fn(),
  };
}

describe("SequentialDeployRunner", () => {
  it("builda uma vez, reavalia e sobe o staging sem novo build", async () => {
    const { runner, orchestrator, preflight, calls } = harness();

    const result = await runner.prepare(input());

    expect(result.imageId).toBe(IMAGE_ID);
    expect(orchestrator.buildCandidate).toHaveBeenCalledTimes(1);
    expect(orchestrator.startStaging).toHaveBeenCalledTimes(1);
    expect(orchestrator.imageId).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(["wait", "build", "image", "wait", "staging", "image", "container"]);
    expect(preflight.waitForSafeHost).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ requiredMemoryMb: 1024, stagingReservationMb: 0 }),
    );
    expect(preflight.waitForSafeHost).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ requiredMemoryMb: 768, stagingReservationMb: 0 }),
    );
  });

  it("não builda quando o preflight da primeira fase reprova", async () => {
    const { runner, orchestrator } = harness({ waits: [{ safe: false }] });

    await expect(runner.prepare(input())).rejects.toMatchObject({ phase: "preflight-build" });
    expect(orchestrator.buildCandidate).not.toHaveBeenCalled();
    expect(orchestrator.startStaging).not.toHaveBeenCalled();
  });

  it("falha de build não cria staging", async () => {
    const { runner, orchestrator } = harness({ buildError: new Error("camada falhou") });

    await expect(runner.prepare(input())).rejects.toMatchObject({
      phase: "build",
      imageBuilt: false,
    });
    expect(orchestrator.startStaging).not.toHaveBeenCalled();
  });

  it("memória insuficiente após o build não sobe staging", async () => {
    const { runner, orchestrator } = harness({ waits: [{ safe: true }, { safe: false }] });

    await expect(runner.prepare(input())).rejects.toMatchObject({
      phase: "preflight-staging",
      imageBuilt: true,
    });
    expect(orchestrator.buildCandidate).toHaveBeenCalledTimes(1);
    expect(orchestrator.startStaging).not.toHaveBeenCalled();
  });

  it("imagem não verificável após o build bloqueia o staging", async () => {
    const { runner, orchestrator } = harness({ imageIds: [null] });

    await expect(runner.prepare(input())).rejects.toMatchObject({ phase: "image-missing" });
    expect(orchestrator.startStaging).not.toHaveBeenCalled();
  });

  it("imagem diferente entre build e staging bloqueia", async () => {
    const { runner } = harness({ imageIds: [IMAGE_ID, OTHER_ID] });

    await expect(runner.prepare(input())).rejects.toMatchObject({
      phase: "image-changed",
      stagingStarted: true,
    });
  });

  it("container de staging rodando outra imagem bloqueia mesmo com a tag correta", async () => {
    const { runner } = harness({ containerIds: [OTHER_ID] });

    await expect(runner.prepare(input())).rejects.toMatchObject({
      phase: "image-changed",
      stagingStarted: true,
    });
  });

  it("falha ao subir staging é reportada sem promoção", async () => {
    const { runner } = harness({ stagingError: new Error("porta ocupada") });

    await expect(runner.prepare(input())).rejects.toMatchObject({
      phase: "staging",
      imageBuilt: true,
    });
  });

  it("não existe caminho para build duplicado", async () => {
    const { runner, orchestrator } = harness();

    await runner.prepare(input());

    expect(orchestrator.buildCandidate).toHaveBeenCalledTimes(1);
    expect(orchestrator.startStaging).toHaveBeenCalledTimes(1);
  });

  it("referência do candidato exige nome e tag", () => {
    expect(sequentialCandidateReference(config())).toBe(
      "korrelo-mesatta-8452004c:commit-aaaaaaabbbbb",
    );
    expect(sequentialCandidateReference({ ...config(), imageTag: undefined })).toBeNull();
  });

  it("flag é OFF por padrão e só liga com valor explícito", () => {
    expect(isSequentialBuildEnabled({})).toBe(false);
    expect(isSequentialBuildEnabled({ KORRELO_SEQUENTIAL_BUILD: "0" })).toBe(false);
    expect(isSequentialBuildEnabled({ KORRELO_SEQUENTIAL_BUILD: "false" })).toBe(false);
    expect(isSequentialBuildEnabled({ KORRELO_SEQUENTIAL_BUILD: "1" })).toBe(true);
    expect(isSequentialBuildEnabled({ KORRELO_SEQUENTIAL_BUILD: "true" })).toBe(true);
  });

  it("erro carrega fase e estado para diagnóstico sem vazar segredos", async () => {
    const { runner } = harness({ waits: [{ safe: false, reason: "PSI alto" }] });

    try {
      await runner.prepare(input());
      throw new Error("deveria falhar");
    } catch (error) {
      expect(error).toBeInstanceOf(SequentialDeployError);
      expect((error as SequentialDeployError).phase).toBe("preflight-build");
      expect((error as Error).message).toContain("PSI alto");
    }
  });
});
