import { execFile } from "node:child_process";
import {
  planStaging,
  type StagingHostCapacity,
  type StagingPlanInput,
  type StagingProjectConfig,
  type StagingProductionContext,
} from "./staging-planner";

jest.mock("node:child_process", () => ({ execFile: jest.fn() }));

const PROJECT_ID = "project-1111";
const RUN_ID = "job-2222";

const production: StagingProductionContext = {
  volumes: ["uploads-data"],
  networks: ["korrelo-shared", "prod-net"],
  databaseTargets: [
    { scheme: "postgresql", host: "db", port: 5432, database: "korrelo" },
    { scheme: "mongodb", host: "mongo", port: 27017, database: "korrelo" },
  ],
  secretFingerprints: ["prod-secret-fingerprint"],
  hostPorts: [4100],
};

const host: StagingHostCapacity = {
  availableCpu: 2,
  availableMemoryMb: 2048,
  freeDiskMb: 8192,
  activeEnvironments: 0,
  maxConcurrentEnvironments: 1,
  maxTtlMinutes: 120,
  portCandidates: [4101, 4102],
  unavailablePorts: [],
};

function makeConfig(overrides: Partial<StagingProjectConfig> = {}): StagingProjectConfig {
  return {
    mode: "isolated",
    ttlMinutes: 60,
    allowEgress: false,
    app: { memoryMb: 512, cpu: 0.5, diskMb: 1024, mounts: [] },
    env: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<StagingPlanInput> = {}): StagingPlanInput {
  return {
    projectId: PROJECT_ID,
    runId: RUN_ID,
    config: makeConfig(),
    dependencies: [],
    production,
    host,
    ...overrides,
  };
}

describe("staging planner (P0)", () => {
  it("projeto sem configuração permanece no fluxo legado, sem exigir host/produção", () => {
    const result = planStaging({ projectId: PROJECT_ID, runId: RUN_ID, config: null });

    expect(result.ok).toBe(true);
    expect(result.legacy).toBe(true);
    expect(result.mode).toBe("legacy");
    expect(result.plan).toBeNull();
    expect(result.issues).toHaveLength(0);
  });

  it("configuração explícita legacy também não valida nem planeja isolamento", () => {
    const result = planStaging(makeInput({ config: makeConfig({ mode: "legacy" }) }));

    expect(result.ok).toBe(true);
    expect(result.legacy).toBe(true);
    expect(result.plan).toBeNull();
  });

  it("planeja staging isolado válido sem banco, com porta loopback do alocador", () => {
    const result = planStaging(makeInput());
    const plan = result.plan!;

    expect(result.ok).toBe(true);
    expect(result.legacy).toBe(false);
    expect(plan.mode).toBe("isolated");
    expect(plan.app.hostPort).toBe(4101);
    expect(plan.app.hostBind).toBe("127.0.0.1:4101");
    expect(plan.network.name).toBe("korrelo-stg-project-1111-job-2222-net");
    expect(plan.network.sharedNetwork).toBe(false);
    expect(plan.network.egressEnabled).toBe(false);
    expect(plan.network.publicDomain).toBeNull();
    expect(plan.dependencies).toHaveLength(0);
    expect(plan.volumes).toContain("korrelo-stg-project-1111-job-2222-uploads");
    expect(plan.requiresAtomicPortReservation).toBe(true);
  });

  it("dependência não suportada é recusada", () => {
    const result = planStaging(
      makeInput({
        dependencies: [
          {
            name: "events",
            kind: "kafka",
            envKey: "KAFKA_URL",
            resources: { memoryMb: 128, cpu: 0.1, diskMb: 64 },
          },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.plan).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toContain("STAGING_UNSUPPORTED_DEPENDENCY");
  });

  it("configuração incompleta é recusada sem assumir limites padrão", () => {
    const result = planStaging(
      makeInput({
        config: { mode: "isolated", ttlMinutes: 60 } as unknown as StagingProjectConfig,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("STAGING_CONFIG_INCOMPLETE");
  });

  it("credencial de produção é recusada por fingerprint", () => {
    const result = planStaging(
      makeInput({
        config: makeConfig({
          env: [{ key: "API_SECRET", source: "explicit", fingerprint: "prod-secret-fingerprint" }],
        }),
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("STAGING_PRODUCTION_CREDENTIAL");
  });

  it("volume de produção e nome legado compartilhado são recusados", () => {
    for (const source of ["uploads-data", "korrelo-data-production"]) {
      const result = planStaging(
        makeInput({
          config: makeConfig({
            app: {
              memoryMb: 512,
              cpu: 0.5,
              diskMb: 1024,
              mounts: [{ type: "volume", source, target: "/app/uploads" }],
            },
          }),
        }),
      );

      expect(result.ok).toBe(false);
      expect(result.issues.map((issue) => issue.code)).toContain("STAGING_PRODUCTION_VOLUME");
    }
  });

  it("rede compartilhada de produção é recusada", () => {
    for (const network of [
      { shared: true, name: "korrelo-shared" },
      { name: "korrelo-shared" },
      { name: "prod-net" },
    ]) {
      const result = planStaging(makeInput({ config: makeConfig({ network }) }));

      expect(result.ok).toBe(false);
      const codes = result.issues.map((issue) => issue.code);
      expect(
        codes.includes("STAGING_SHARED_NETWORK") || codes.includes("STAGING_PRODUCTION_NETWORK"),
      ).toBe(true);
    }
  });

  it("docker socket, privileged e network_mode host são recusados", () => {
    const result = planStaging(
      makeInput({
        config: makeConfig({
          security: {
            dockerSocketMounted: true,
            privileged: true,
            networkMode: "host",
          },
        }),
        authorizedBindMounts: ["/var/run/docker.sock"],
      }),
    );

    expect(result.ok).toBe(false);
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("STAGING_DOCKER_SOCKET");
    expect(codes).toContain("STAGING_PRIVILEGED");
    expect(codes).toContain("STAGING_HOST_NETWORK");
  });

  it("bind mount não autorizado é recusado", () => {
    const result = planStaging(
      makeInput({
        config: makeConfig({
          app: {
            memoryMb: 512,
            cpu: 0.5,
            diskMb: 1024,
            mounts: [{ type: "bind", source: "/tmp/uploads", target: "/app/uploads" }],
          },
        }),
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("STAGING_BIND_MOUNT");
  });

  it("bind mount explicitamente autorizado é aceito", () => {
    const result = planStaging(
      makeInput({
        config: makeConfig({
          app: {
            memoryMb: 512,
            cpu: 0.5,
            diskMb: 1024,
            mounts: [
              { type: "bind", source: "/srv/fixtures", target: "/app/fixtures", authorized: true, readOnly: true },
            ],
          },
        }),
        authorizedBindMounts: ["/srv/fixtures"],
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.plan?.app.mounts).toContainEqual({
      type: "bind",
      source: "/srv/fixtures",
      target: "/app/fixtures",
      readOnly: true,
    });
  });

  it("target externo igual a banco de produção é recusado", () => {
    const result = planStaging(
      makeInput({
        dependencies: [
          {
            name: "database",
            kind: "external",
            envKey: "DATABASE_URL",
            secretFingerprint: "staging-external-secret",
            target: { scheme: "POSTGRESQL", host: "DB", port: 5432, database: "korrelo" },
          },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("STAGING_PRODUCTION_DATABASE");
  });

  it("falta de CPU, memória e disco bloqueia o plano", () => {
    const result = planStaging(
      makeInput({
        host: {
          ...host,
          availableCpu: 0.1,
          availableMemoryMb: 100,
          freeDiskMb: 100,
        },
      }),
    );

    expect(result.ok).toBe(false);
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("STAGING_RESOURCE_CPU");
    expect(codes).toContain("STAGING_RESOURCE_MEMORY");
    expect(codes).toContain("STAGING_RESOURCE_DISK");
  });

  it("conflito de porta bloqueia quando todos os candidatos estão ocupados", () => {
    const result = planStaging(
      makeInput({
        host: { ...host, portCandidates: [4100, 4101], unavailablePorts: [4100, 4101] },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("STAGING_PORT_CONFLICT");
  });

  it("múltiplas dependências são planejadas com somas explícitas", () => {
    const result = planStaging(
      makeInput({
        dependencies: [
          { name: "database", kind: "postgres", envKey: "DATABASE_URL", resources: { memoryMb: 512, cpu: 0.5, diskMb: 1024 } },
          { name: "cache", kind: "redis", envKey: "REDIS_URL", resources: { memoryMb: 128, cpu: 0.25, diskMb: 256 } },
          { name: "sqlite", kind: "sqlite", resources: { memoryMb: 0, cpu: 0, diskMb: 64 } },
          {
            name: "billing",
            kind: "external",
            envKey: "BILLING_URL",
            secretFingerprint: "staging-billing-secret",
            target: { scheme: "https", host: "billing.staging.example", port: 443, database: null },
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    const plan = result.plan!;
    expect(plan.dependencies).toHaveLength(4);
    expect(plan.resources.memoryMb).toBe(1152);
    expect(plan.resources.cpu).toBe(1.25);
    expect(plan.resources.diskMb).toBe(2368);
    expect(plan.dependencies.find((dep) => dep.kind === "external")?.serviceName).toBeNull();
    expect(plan.dependencies.find((dep) => dep.kind === "sqlite")?.mode).toBe("file");
  });

  it("modelo aceita todos os tipos de dependência suportados", () => {
    const result = planStaging(
      makeInput({
        dependencies: [
          { name: "postgres-db", kind: "postgres", envKey: "POSTGRES_URL", resources: { memoryMb: 256, cpu: 0.25, diskMb: 512 } },
          { name: "mongo-db", kind: "mongodb", envKey: "MONGO_URL", resources: { memoryMb: 256, cpu: 0.25, diskMb: 512 } },
          { name: "mysql-db", kind: "mysql", envKey: "MYSQL_URL", resources: { memoryMb: 256, cpu: 0.25, diskMb: 512 } },
          { name: "cache", kind: "redis", envKey: "REDIS_URL", resources: { memoryMb: 128, cpu: 0.25, diskMb: 128 } },
          { name: "local-file", kind: "sqlite", resources: { memoryMb: 0, cpu: 0, diskMb: 64 } },
          {
            name: "external-api",
            kind: "external",
            envKey: "EXTERNAL_API_URL",
            secretFingerprint: "staging-external-secret",
            target: { scheme: "https", host: "api.staging.example", port: 443, database: null },
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.plan?.dependencies.map((dependency) => dependency.kind)).toEqual([
      "postgres",
      "mongodb",
      "mysql",
      "redis",
      "sqlite",
      "external",
    ]);
  });

  it("contexto de produção ausente falha fechado", () => {
    const result = planStaging(makeInput({ production: undefined }));

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("STAGING_PRODUCTION_CONTEXT_MISSING");
  });

  it("variável reservada e variável duplicada são recusadas", () => {
    const result = planStaging(
      makeInput({
        config: makeConfig({
          env: [
            { key: "KORELO_DEPLOY_ENV", source: "explicit" },
            { key: "API_KEY", source: "explicit" },
            { key: "API_KEY", source: "explicit" },
          ],
        }),
      }),
    );

    expect(result.ok).toBe(false);
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("STAGING_RESERVED_ENV");
    expect(codes).toContain("STAGING_DUPLICATE_ENV");
  });

  it("dependência de outro projeto viola isolamento", () => {
    const result = planStaging(
      makeInput({
        dependencies: [
          {
            name: "database",
            kind: "postgres",
            projectId: "other-project",
            envKey: "DATABASE_URL",
            resources: { memoryMb: 256, cpu: 0.25, diskMb: 512 },
          },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("STAGING_DEPENDENCY_PROJECT_MISMATCH");
  });

  it("egress é desabilitado por padrão e só liga com configuração explícita", () => {
    const disabled = planStaging(makeInput());
    const enabled = planStaging(makeInput({ config: makeConfig({ allowEgress: true }) }));

    expect(disabled.plan?.network.egressEnabled).toBe(false);
    expect(enabled.plan?.network.egressEnabled).toBe(true);
  });

  it("domínio público e TTL acima do máximo são recusados", () => {
    const result = planStaging(
      makeInput({
        config: makeConfig({
          ttlMinutes: 121,
          security: { publicDomain: "staging.example.com" },
        }),
      }),
    );

    expect(result.ok).toBe(false);
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("STAGING_PUBLIC_EXPOSURE");
    expect(codes).toContain("STAGING_TTL_INVALID");
  });

  it("limite de ambientes simultâneos é respeitado", () => {
    const result = planStaging(makeInput({ host: { ...host, activeEnvironments: 1 } }));

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("STAGING_CONCURRENCY_LIMIT");
  });

  it("dois projetos com o mesmo run geram nomes e planos diferentes", () => {
    const first = planStaging(makeInput({ projectId: "project-a" }));
    const second = planStaging(makeInput({ projectId: "project-b" }));

    expect(first.plan?.composeProject).not.toBe(second.plan?.composeProject);
    expect(first.plan?.app.containerName).not.toBe(second.plan?.app.containerName);
  });

  it("não executa nenhum comando de processo/Docker", () => {
    planStaging(makeInput());
    expect(execFile).not.toHaveBeenCalled();
  });
});
