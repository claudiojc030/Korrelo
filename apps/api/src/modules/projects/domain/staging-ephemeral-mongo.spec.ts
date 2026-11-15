import { buildEphemeralMongo } from "./staging-ephemeral-mongo";
import type { StagingPlanDependency } from "./staging-planner";

function dependency(overrides: Partial<StagingPlanDependency> = {}): StagingPlanDependency {
  return {
    name: "mongo",
    kind: "mongodb",
    mode: "ephemeral",
    serviceName: "app_staging-mongo",
    containerName: "app-stg-mongo",
    envKey: "MONGO_URL",
    resources: { memoryMb: 256, cpu: 0.25, diskMb: 256 },
    volumeName: "korrelo-stg-p-r-mongo-data",
    target: null,
    healthcheck: null,
    ...overrides,
  };
}

describe("buildEphemeralMongo", () => {
  it("gera credenciais aleatórias, URI interna e healthcheck", () => {
    const first = buildEphemeralMongo({ dependency: dependency() });
    const second = buildEphemeralMongo({ dependency: dependency() });

    expect(first.ok).toBe(true);
    expect(first.plan?.appEnv.MONGO_URL).toMatch(
      /^mongodb:\/\/korrelo_[a-f0-9]+:[A-Za-z0-9_-]+@app_staging-mongo:27017\/staging\?authSource=admin$/,
    );
    expect(first.plan?.dependencyEnv.MONGO_INITDB_ROOT_PASSWORD).not.toBe(
      second.plan?.dependencyEnv.MONGO_INITDB_ROOT_PASSWORD,
    );
    expect(first.plan?.healthcheck).toContain("mongosh");
    expect(first.plan?.image).toBe("mongo:7");
  });

  it("não usa porta publicada nem banco externo", () => {
    const result = buildEphemeralMongo({ dependency: dependency() });
    expect(result.plan?.appEnv.MONGO_URL).not.toContain("localhost");
    expect(result.plan?.appEnv.MONGO_URL).not.toContain("27017:27017");
  });

  it("exige envKey e recusa chave crítica", () => {
    expect(buildEphemeralMongo({ dependency: dependency({ envKey: null }) }).ok).toBe(false);
    expect(buildEphemeralMongo({ dependency: dependency({ envKey: "KORRELO_MONGO_URL" }) }).ok).toBe(false);
  });

  it("recusa dependência não efêmera e banco inválido", () => {
    expect(buildEphemeralMongo({ dependency: dependency({ mode: "external" }) }).ok).toBe(false);
    expect(buildEphemeralMongo({ dependency: dependency(), database: "../prod" }).ok).toBe(false);
  });
});
