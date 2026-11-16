import { StagingDeployIntegrationService } from "./staging-deploy-integration.service";
import type { StagingExecutionService } from "./staging-execution.service";
import type { StagingConfigLoader } from "../domain/persisted-staging-config";
import type { StagingContextCollector } from "../domain/staging-context";

/**
 * Garantia de rollout: a flag do staging isolado é OPT-IN estrita.
 *
 * `KORRELO_STAGING_ISOLATED_EXECUTION` ausente, vazia, "1" ou "TRUE" NÃO liga o
 * staging. Só o literal "true" liga. Sem a flag, uma configuração isolada falha
 * fechada — nunca cai para o staging legado.
 */
function isolatedLoader(): StagingConfigLoader {
  return {
    load: async () => ({
      ok: true,
      legacy: false,
      issues: [],
      dependencies: [
        {
          name: "mongo",
          kind: "mongodb",
          mode: "ephemeral",
          envKey: "MONGODB_URI",
          resources: { memoryMb: 384, cpu: 0.25, diskMb: 256 },
        },
      ],
      config: {
        mode: "isolated",
        ttlMinutes: 20,
        allowEgress: false,
        app: { memoryMb: 1024, cpu: 0.5, diskMb: 1024, mounts: [] },
      },
    }),
  };
}

const collector: StagingContextCollector = {
  collect: async () => ({
    ok: true,
    issues: [],
    snapshot: {
      production: { volumes: [], networks: [], databaseTargets: [], secretFingerprints: [], hostPorts: [] },
      host: {
        availableCpu: 4,
        availableMemoryMb: 4096,
        freeDiskMb: 20_000,
        activeEnvironments: 0,
        maxConcurrentEnvironments: 4,
        maxTtlMinutes: 240,
        portCandidates: [19100, 19101],
      },
      warnings: [],
    },
  }),
};

function executor() {
  const execute = jest.fn().mockResolvedValue({
    ok: true,
    issues: [],
    composeHash: "hash",
    run: { runId: "job-1", imageId: "sha256:" + "a".repeat(64) },
  });
  return { service: { execute } as unknown as StagingExecutionService, execute };
}

const input = {
  projectId: "proj-1",
  projectName: "Mesatta",
  deployJobId: "job-1",
  commitSha: "125a4ab69975ecf865da8c96ee262cf01eb13a43",
  imageReference: "mesatta:validada",
  containerPort: 3000,
  portCandidates: [19100, 19101],
};

describe("flag do staging isolado (default)", () => {
  const previous = process.env.KORRELO_STAGING_ISOLATED_EXECUTION;

  afterEach(() => {
    if (previous === undefined) delete process.env.KORRELO_STAGING_ISOLATED_EXECUTION;
    else process.env.KORRELO_STAGING_ISOLATED_EXECUTION = previous;
  });

  it.each([undefined, "", "1", "TRUE", "yes", "false"])(
    "valor %p mantém o staging desligado e falha fechado",
    async (value) => {
      if (value === undefined) delete process.env.KORRELO_STAGING_ISOLATED_EXECUTION;
      else process.env.KORRELO_STAGING_ISOLATED_EXECUTION = value;

      const fake = executor();
      const service = new StagingDeployIntegrationService(isolatedLoader(), collector, fake.service);
      const result = await service.prepare(input);

      expect(result.ok).toBe(false);
      expect(result.mode).toBe("isolated");
      expect(result.issues.join(" ")).toContain("KORRELO_STAGING_ISOLATED_EXECUTION");
      expect(fake.execute).not.toHaveBeenCalled();
    },
  );

  it('somente o literal "true" habilita o executor', async () => {
    process.env.KORRELO_STAGING_ISOLATED_EXECUTION = "true";
    const fake = executor();
    const service = new StagingDeployIntegrationService(isolatedLoader(), collector, fake.service);
    await service.prepare(input);
    expect(fake.execute).toHaveBeenCalledTimes(1);
  });
});
