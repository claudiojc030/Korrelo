import { PersistedStagingConfigLoader } from "./persisted-staging-config.loader";
import type {
  PersistedStagingConfig,
  StagingConfigRepository,
} from "../domain/persisted-staging-config";

class FakeRepository implements StagingConfigRepository {
  record: PersistedStagingConfig | null = null;
  fail = false;
  secretValue: string | null = "external-secret";
  async findByProjectId(): Promise<PersistedStagingConfig | null> {
    if (this.fail) throw new Error("config db indisponível");
    return this.record;
  }
  async save(): Promise<PersistedStagingConfig> {
    throw new Error("not used");
  }
  async deleteByProjectId(): Promise<void> {}
  async resolveSecretValue(): Promise<string | null> {
    return this.secretValue;
  }
}

function record(overrides: Partial<PersistedStagingConfig> = {}): PersistedStagingConfig {
  return {
    id: "config-1",
    projectId: "project-1",
    mode: "isolated",
    ttlMinutes: 60,
    allowEgress: false,
    app: { memoryMb: 512, cpu: 0.5, diskMb: 1024 },
    dependencies: [
      {
        id: "dep-1",
        name: "billing",
        kind: "external",
        mode: "external",
        envKey: "BILLING_URL",
        target: { scheme: "https", host: "billing.staging.example", port: 443, database: null },
        resources: null,
        externalSecretId: "secret-1",
        healthcheck: null,
      },
      {
        id: "dep-2",
        name: "database",
        kind: "postgres",
        mode: "ephemeral",
        envKey: "DATABASE_URL",
        target: null,
        resources: { memoryMb: 256, cpu: 0.25, diskMb: 512 },
        externalSecretId: null,
        healthcheck: null,
      },
    ],
    secrets: [
      { id: "secret-1", key: "BILLING_SECRET", createdAt: new Date(), updatedAt: new Date() },
      { id: "secret-2", key: "APP_FLAG", createdAt: new Date(), updatedAt: new Date() },
    ],
    ...overrides,
  };
}

describe("PersistedStagingConfigLoader (P1B1)", () => {
  it("ausência de configuração retorna legado", async () => {
    const repo = new FakeRepository();
    repo.record = null;
    const loader = new PersistedStagingConfigLoader(repo);

    const result = await loader.load("project-1");

    expect(result).toMatchObject({ ok: true, legacy: true, config: null, dependencies: [] });
  });

  it("mapeia configuração persistida para o P0 sem expor segredo", async () => {
    const repo = new FakeRepository();
    repo.record = record();
    const loader = new PersistedStagingConfigLoader(repo);

    const result = await loader.load("project-1");

    expect(result.ok).toBe(true);
    expect(result.legacy).toBe(false);
    expect(result.config).toMatchObject({
      mode: "isolated",
      ttlMinutes: 60,
      allowEgress: false,
      app: { memoryMb: 512, cpu: 0.5, diskMb: 1024 },
    });
    expect(result.config?.env).toEqual([{ key: "APP_FLAG", source: "explicit" }]);
    const external = result.dependencies.find((dependency) => dependency.kind === "external");
    expect(external?.secretFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("external-secret");
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });

  it("segredo externo ausente falha fechado", async () => {
    const repo = new FakeRepository();
    repo.record = record({
      dependencies: [
        {
          id: "dep-1",
          name: "billing",
          kind: "external",
          mode: "external",
          envKey: "BILLING_URL",
          target: { scheme: "https", host: "billing.example", port: 443, database: null },
          resources: null,
          externalSecretId: null,
          healthcheck: null,
        },
      ],
    });
    const loader = new PersistedStagingConfigLoader(repo);

    const result = await loader.load("project-1");

    expect(result.ok).toBe(false);
    expect(result.issues[0].code).toBe("STAGING_CONFIG_INCOMPLETE");
  });

  it("falha de leitura do repositório não vira legado", async () => {
    const repo = new FakeRepository();
    repo.fail = true;
    const loader = new PersistedStagingConfigLoader(repo);

    const result = await loader.load("project-1");

    expect(result.ok).toBe(false);
    expect(result.legacy).toBe(false);
    expect(result.issues[0].code).toBe("STAGING_CONFIG_UNAVAILABLE");
  });

  it("modo persistido inválido é recusado", async () => {
    const repo = new FakeRepository();
    repo.record = record({ mode: "legacy" });
    const loader = new PersistedStagingConfigLoader(repo);

    const result = await loader.load("project-1");

    expect(result.ok).toBe(false);
    expect(result.issues[0].code).toBe("STAGING_CONFIG_INVALID");
  });
});
