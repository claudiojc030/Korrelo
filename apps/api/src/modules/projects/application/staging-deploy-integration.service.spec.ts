import { StagingDeployIntegrationService } from "./staging-deploy-integration.service";
import type { StagingConfigLoader, StagingConfigLoadResult } from "../domain/persisted-staging-config";
import type { StagingContextCollector } from "../domain/staging-context";
import type { StagingExecutionService } from "./staging-execution.service";
import type { StagingExecutionResult } from "../domain/staging-execution";

const commit = "a".repeat(40);

function loader(result: StagingConfigLoadResult): StagingConfigLoader {
  return { load: async () => result };
}

const legacy: StagingConfigLoadResult = { ok: true, legacy: true, config: null, dependencies: [], issues: [] };

function isolated(overrides: Partial<StagingConfigLoadResult> = {}): StagingConfigLoadResult {
  return {
    ok: true,
    legacy: false,
    config: {
      mode: "isolated",
      ttlMinutes: 30,
      allowEgress: false,
      app: { memoryMb: 256, cpu: 0.25, diskMb: 256 },
      env: [],
    },
    dependencies: [],
    issues: [],
    ...overrides,
  };
}

function collector(): StagingContextCollector {
  return {
    collect: async () => ({
      ok: true,
      issues: [],
      snapshot: {
        production: { volumes: [], networks: [], databaseTargets: [], secretFingerprints: [] },
        host: {
          availableCpu: 4,
          availableMemoryMb: 4096,
          freeDiskMb: 20_000,
          activeEnvironments: 0,
          maxConcurrentEnvironments: 4,
          maxTtlMinutes: 240,
          portCandidates: [18100],
        },
        warnings: [],
      },
    }),
  };
}

function executor(result: Partial<StagingExecutionResult> = {}) {
  const execute = jest.fn(async () => ({
    ok: true,
    status: "healthy" as const,
    run: { runId: "job-job-1" } as never,
    lease: null,
    composeHash: "hash",
    issues: [],
    ...result,
  }));
  return { service: { execute } as unknown as StagingExecutionService, execute };
}

const input = {
  projectId: "project-1",
  deployJobId: "job-1",
  commitSha: commit,
  imageReference: "korrelo-app:commit-aaaaaaaaaaaa",
  containerPort: 3000,
  portCandidates: [18100, 18101],
  healthPath: "/health",
  healthRequire2xx: true,
};

describe("StagingDeployIntegrationService", () => {
  it("sem configuração persistida permanece legado e não chama executor", async () => {
    const fake = executor();
    const service = new StagingDeployIntegrationService(loader(legacy), collector(), fake.service, true);
    const result = await service.prepare(input);
    expect(result.mode).toBe("legacy");
    expect(result.ok).toBe(true);
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it("modo isolado com flag desligada falha fechado, sem fallback", async () => {
    const fake = executor();
    const service = new StagingDeployIntegrationService(loader(isolated()), collector(), fake.service, false);
    const result = await service.prepare(input);
    expect(result.mode).toBe("isolated");
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("KORRELO_STAGING_ISOLATED_EXECUTION");
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it("dependências (bancos) bloqueiam o deploy isolado nesta fase", async () => {
    const fake = executor();
    const service = new StagingDeployIntegrationService(
      loader(
        isolated({
          dependencies: [
            {
              name: "mongo",
              kind: "mongodb",
              mode: "ephemeral",
              envKey: "MONGO_URL",
              target: undefined,
              resources: { memoryMb: 256, cpu: 0.25, diskMb: 256 },
              healthcheck: undefined,
            },
          ],
        }),
      ),
      collector(),
      fake.service,
      true,
    );
    const result = await service.prepare(input);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("dependências");
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it("executor reprovado bloqueia a promoção", async () => {
    const fake = executor({ ok: false, status: "failed", issues: ["healthcheck do staging reprovado"] });
    const service = new StagingDeployIntegrationService(loader(isolated()), collector(), fake.service, true);
    const result = await service.prepare(input);
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toContain("healthcheck");
  });

  it("aprovado usa imagem pré-construída e repassa sonda HTTP do deploy", async () => {
    const fake = executor();
    const service = new StagingDeployIntegrationService(loader(isolated()), collector(), fake.service, true);
    const result = await service.prepare(input);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("isolated");
    const [request, httpHealth] = fake.execute.mock.calls[0] as unknown as [Record<string, unknown>, unknown];
    expect((request as { mode: string }).mode).toBe("prebuilt");
    expect(httpHealth).toEqual({ path: "/health", require2xx: true, containerPort: 3000 });
  });

  it("config inválida bloqueia sem consultar planner", async () => {
    const fake = executor();
    const service = new StagingDeployIntegrationService(
      loader({ ok: false, legacy: false, config: null, dependencies: [], issues: [{ code: "X", field: "y", message: "config inválida" }] }),
      collector(),
      fake.service,
      true,
    );
    const result = await service.prepare(input);
    expect(result.ok).toBe(false);
    expect(fake.execute).not.toHaveBeenCalled();
  });
});
