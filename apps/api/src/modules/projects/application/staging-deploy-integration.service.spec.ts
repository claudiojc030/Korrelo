import { StagingDeployIntegrationService } from "./staging-deploy-integration.service";
import type { StagingConfigLoader, StagingConfigLoadResult } from "../domain/persisted-staging-config";
import type { StagingContextCollector } from "../domain/staging-context";
import type { StagingExecutionService } from "./staging-execution.service";
import type { StagingExecutionResult, StagingImageVerifier } from "../domain/staging-execution";

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

  it("bloqueia egress externo no staging de homologação", async () => {
    const fake = executor();
    const config = isolated();
    config.config = { ...config.config!, allowEgress: true };
    const service = new StagingDeployIntegrationService(loader(config), collector(), fake.service, true);
    const result = await service.prepare(input);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("egress");
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it("MongoDB efêmero entra no executor com credenciais próprias", async () => {
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
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    const [request] = fake.execute.mock.calls[0] as unknown as [Record<string, unknown>];
    const stagingEnv = request.stagingEnv as Record<string, string>;
    expect(stagingEnv.MONGO_URL).toContain("@");
    expect(stagingEnv.MONGO_URL).toContain(":27017");
    expect(stagingEnv.MONGO_URL).not.toContain("production");
    const dependencyEnv = request.dependencyEnvironment as Record<string, Record<string, string>>;
    expect(dependencyEnv.mongo.MONGO_INITDB_ROOT_PASSWORD.length).toBeGreaterThan(10);
    expect(request.dependencies).toHaveLength(1);
  });

  it("dependência que não seja MongoDB efêmero bloqueia o deploy", async () => {
    const fake = executor();
    const service = new StagingDeployIntegrationService(
      loader(
        isolated({
          dependencies: [
            {
              name: "pg",
              kind: "postgres",
              mode: "ephemeral",
              envKey: "DATABASE_URL",
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
    expect(result.issues.join(" ")).toContain("apenas MongoDB");
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it("segredo de staging ausente bloqueia antes do executor", async () => {
    const fake = executor();
    const service = new StagingDeployIntegrationService(
      loader(
        isolated({
          config: {
            mode: "isolated",
            ttlMinutes: 30,
            allowEgress: false,
            app: { memoryMb: 256, cpu: 0.25, diskMb: 256 },
            env: [{ key: "APP_SECRET", source: "explicit" }],
          },
        }),
      ),
      collector(),
      fake.service,
      true,
      {
        resolveSecretValue: async () => null,
      } as never,
    );
    const result = await service.prepare(input);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("APP_SECRET");
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

  function imageVerifier(imageId: string | null) {
    return {
      verify: async () => ({
        ok: imageId !== null,
        identityVerified: imageId !== null,
        originAuthenticated: false as const,
        imageId,
        digest: null,
        issues: imageId === null ? ["imagem inválida"] : [],
      }),
    } as StagingImageVerifier;
  }

  it("aprovado devolve o image ID verificado para a promoção", async () => {
    const fake = executor({ run: { runId: "job-job-1", imageId: "sha256:" + "a".repeat(64) } as never });
    const service = new StagingDeployIntegrationService(
      loader(isolated()),
      collector(),
      fake.service,
      true,
      null,
      imageVerifier("sha256:" + "a".repeat(64)),
    );
    const result = await service.prepare(input);
    expect(result.imageId).toBe("sha256:" + "a".repeat(64));
  });

  it("reconfere o ID da imagem antes da promoção", async () => {
    const expected = "sha256:" + "a".repeat(64);
    const service = new StagingDeployIntegrationService(
      loader(isolated()),
      collector(),
      executor().service,
      true,
      null,
      imageVerifier(expected),
    );

    await expect(
      service.verifyImageUnchanged({
        projectId: input.projectId,
        commitSha: input.commitSha,
        imageReference: input.imageReference,
        expectedImageId: expected,
      }),
    ).resolves.toBe(true);

    await expect(
      service.verifyImageUnchanged({
        projectId: input.projectId,
        commitSha: input.commitSha,
        imageReference: input.imageReference,
        expectedImageId: "sha256:" + "b".repeat(64),
      }),
    ).resolves.toBe(false);
  });

  it("sem verificador ou sem ID esperado a promoção é bloqueada", async () => {
    const service = new StagingDeployIntegrationService(loader(isolated()), collector(), executor().service, true);
    await expect(
      service.verifyImageUnchanged({
        projectId: input.projectId,
        commitSha: input.commitSha,
        imageReference: input.imageReference,
        expectedImageId: null,
      }),
    ).resolves.toBe(false);
  });
});
