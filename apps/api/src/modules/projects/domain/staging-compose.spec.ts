import {
  generateStagingCompose,
  serializeStagingCompose,
  validateStagingCompose,
  type StagingComposeRequest,
} from "./staging-compose";
import { hashStagingPlan, stableStringify } from "./staging-plan-hash";
import { planStaging, type StagingPlanInput } from "./staging-planner";

const production = {
  volumes: ["uploads-data"],
  networks: ["korrelo-shared", "prod_default"],
  databaseTargets: [],
  secretFingerprints: [],
  hostPorts: [3000],
};

const host = {
  availableCpu: 4,
  availableMemoryMb: 4096,
  freeDiskMb: 20_000,
  activeEnvironments: 0,
  maxConcurrentEnvironments: 2,
  maxTtlMinutes: 120,
  portCandidates: [4100],
  unavailablePorts: [],
};

function input(overrides: Partial<StagingPlanInput> = {}): StagingPlanInput {
  return {
    projectId: "project-compose",
    runId: "run-compose",
    config: {
      mode: "isolated",
      ttlMinutes: 30,
      allowEgress: false,
      app: { memoryMb: 512, cpu: 0.5, diskMb: 1024, mounts: [] },
      env: [],
    },
    dependencies: [],
    production,
    host,
    ...overrides,
  };
}

function makePlan(overrides: Partial<StagingPlanInput> = {}) {
  const result = planStaging(input(overrides));
  if (!result.plan) throw new Error(`plano inválido no teste: ${JSON.stringify(result.issues)}`);
  return result.plan;
}

function request(plan = makePlan(), overrides: Partial<StagingComposeRequest> = {}): StagingComposeRequest {
  return {
    plan,
    containerPort: 3000,
    pidsLimit: 128,
    imageReference: "korrelo-app:commit-abc",
    deployJobId: "job-1",
    ...overrides,
  };
}

describe("staging compose generator (P1C)", () => {
  it("gera app sem banco com rede isolada, volumes, loopback e limites", () => {
    const plan = makePlan();
    const result = generateStagingCompose(request(plan));

    expect(result.ok).toBe(true);
    expect(result.model?.name).toBe(plan.composeProject);
    expect(result.model?.services.app_staging).toMatchObject({
      container_name: plan.app.containerName,
      image: "korrelo-app:commit-abc",
      restart: "no",
      networks: ["internal"],
      ports: [`${plan.app.hostBind}:3000`],
      mem_limit: "512m",
      cpus: 0.5,
      pids_limit: 128,
    });
    expect(result.model?.services.app_staging.volumes).toEqual(
      expect.arrayContaining([`${plan.volumes[0]}:/app/uploads`]),
    );
    expect(result.model?.networks.internal).toMatchObject({ name: plan.network.name, internal: true });
    expect(result.model?.networks.egress).toBeUndefined();
    expect(result.composeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.planHash).toBe(hashStagingPlan(plan));
  });

  it("gera dependência local somente com imagem explícita e sem executar banco", () => {
    const plan = makePlan({
      dependencies: [
        {
          name: "database",
          kind: "postgres",
          envKey: "DATABASE_URL",
          resources: { memoryMb: 256, cpu: 0.25, diskMb: 512 },
        },
      ],
    });

    const missingImage = generateStagingCompose(request(plan));
    expect(missingImage.ok).toBe(false);
    expect(missingImage.issues.map((issue) => issue.code)).toContain("STAGING_COMPOSE_DEPENDENCY_IMAGE_REQUIRED");

    const result = generateStagingCompose(
      request(plan, { dependencyImages: { database: "postgres:16-alpine" } }),
    );
    expect(result.ok).toBe(true);
    expect(result.model?.services["stg-database"]).toMatchObject({
      image: "postgres:16-alpine",
      restart: "no",
      networks: ["internal"],
    });
    expect(result.model?.services.app_staging.depends_on).toEqual(["stg-database"]);
    expect(result.model?.services["stg-database"].ports).toBeUndefined();
  });

  it("egress é bloqueado por padrão e explícito quando o plano autoriza", () => {
    const blocked = generateStagingCompose(request(makePlan()));
    const allowed = generateStagingCompose(
      request(makePlan({
        config: {
          mode: "isolated",
          ttlMinutes: 30,
          allowEgress: true,
          app: { memoryMb: 512, cpu: 0.5, diskMb: 1024, mounts: [] },
          env: [],
        },
      })),
    );

    expect(blocked.model?.networks.egress).toBeUndefined();
    expect(allowed.model?.networks.egress).toMatchObject({ internal: false });
    expect(allowed.model?.services.app_staging.networks).toEqual(["internal", "egress"]);
  });

  it("inclui healthcheck explícito e labels de ownership", () => {
    const result = generateStagingCompose(
      request(makePlan(), {
        healthcheck: {
          test: ["CMD", "wget", "--spider", "-q", "http://127.0.0.1:3000/health"],
          intervalSeconds: 10,
          timeoutSeconds: 3,
          retries: 3,
          startPeriodSeconds: 20,
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.model?.services.app_staging.healthcheck).toMatchObject({
      test: ["CMD", "wget", "--spider", "-q", "http://127.0.0.1:3000/health"],
      interval: "10s",
      timeout: "3s",
    });
    expect(result.model?.services.app_staging.labels).toMatchObject({
      "korrelo.projectId": "project-compose",
      "korrelo.stagingRunId": "run-compose",
      "korrelo.deployJobId": "job-1",
      "korrelo.ephemeral": "true",
    });
  });

  it("representa dependência externa sem criar serviço local nem expor segredo", () => {
    const plan = makePlan({
      dependencies: [
        {
          name: "billing",
          kind: "external",
          envKey: "BILLING_URL",
          secretFingerprint: "fingerprint-not-a-secret-value",
          target: { scheme: "https", host: "billing.staging.example", port: 443, database: null },
        },
      ],
    });
    const result = generateStagingCompose(request(plan));

    expect(result.ok).toBe(true);
    expect(result.model?.services["stg-billing"]).toBeUndefined();
    expect(result.model?.environmentReferences).toContainEqual({
      key: "BILLING_URL",
      source: "dependency",
    });
    expect(result.serialized).not.toContain("fingerprint-not-a-secret-value");
  });

  it("rejeita plano com segurança violada, rede compartilhada e volume de produção", () => {
    const plan = makePlan();
    const badSecurity = { ...plan, security: { ...plan.security, privileged: true } };
    const badNetwork = { ...plan, network: { ...plan.network, name: "korrelo-shared" } };
    const badVolume = { ...plan, volumes: ["uploads-data"] };

    for (const invalid of [badSecurity, badNetwork, badVolume]) {
      const result = generateStagingCompose(request(invalid as typeof plan));
      expect(result.ok).toBe(false);
    }
  });

  it("aceita contexto de build relativo quando não há imagem", () => {
    const result = generateStagingCompose(
      request(makePlan(), { imageReference: undefined, buildContext: ".", dockerfile: "Dockerfile" }),
    );

    expect(result.ok).toBe(true);
    expect(result.model?.services.app_staging.build).toEqual({
      context: ".",
      dockerfile: "Dockerfile",
    });
  });

  it("bloqueia modelo adulterado com privileged, host network, porta pública, socket e volume de produção", () => {
    const plan = makePlan();
    const original = generateStagingCompose(request(plan)).model!;
    const hostile = {
      ...original,
      services: {
        ...original.services,
        app_staging: {
          ...original.services.app_staging,
          ports: ["0.0.0.0:3000:3000"],
          volumes: ["uploads-data:/app/uploads", "/var/run/docker.sock:/var/run/docker.sock"],
          privileged: true,
          network_mode: "host",
        },
      },
      volumes: {
        ...original.volumes,
        "uploads-data": { name: "uploads-data", labels: {} },
      },
    };

    const validation = validateStagingCompose(hostile as typeof original, plan, {
      containerPort: 3000,
      deployJobId: "job-1",
    });

    expect(validation.ok).toBe(false);
    const codes = validation.issues.map((issue) => issue.code);
    expect(codes).toContain("STAGING_COMPOSE_PUBLIC_PORT");
    expect(codes).toContain("STAGING_COMPOSE_DOCKER_SOCKET");
    expect(codes).toContain("STAGING_COMPOSE_PRODUCTION_VOLUME");
    expect(codes).toContain("STAGING_COMPOSE_PRIVILEGED");
    expect(codes).toContain("STAGING_COMPOSE_HOST_NETWORK");
  });

  it("rejeita imagem/build inválidos, bind não autorizado, host network e pids inválido", () => {
    const plan = makePlan();
    for (const bad of [
      request(plan, { imageReference: undefined, buildContext: "../outside" }),
      request(plan, { imageReference: "bad image\nvalue" }),
      request(plan, { imageReference: "image:x", buildContext: "." }),
      request(plan, { pidsLimit: 0 }),
    ]) {
      expect(generateStagingCompose(bad).ok).toBe(false);
    }

    const bindPlan = makePlan({
      authorizedBindMounts: ["/srv/fixtures"],
      config: {
        mode: "isolated",
        ttlMinutes: 30,
        app: {
          memoryMb: 512,
          cpu: 0.5,
          diskMb: 1024,
          mounts: [{ type: "bind", source: "/srv/fixtures", target: "/app/fixtures", authorized: true }],
        },
        env: [],
      },
    });
    expect(generateStagingCompose(request(bindPlan)).ok).toBe(false);
    expect(
      generateStagingCompose(request(bindPlan, { authorizedBindMounts: ["/srv/fixtures"] })).ok,
    ).toBe(true);
  });

  it("rejeita alteração de labels e hash divergente", () => {
    const plan = makePlan();
    const result = generateStagingCompose(request(plan));
    const model = result.model!;
    const invalid = {
      ...model,
      services: {
        ...model.services,
        app_staging: {
          ...model.services.app_staging,
          labels: { ...model.services.app_staging.labels, "korrelo.projectId": "other" },
        },
      },
    };

    const validation = validateStagingCompose(invalid, plan, {
      containerPort: 3000,
      deployJobId: "job-1",
    });
    expect(validation.ok).toBe(false);
    expect(validation.issues.map((issue) => issue.code)).toContain("STAGING_COMPOSE_OWNERSHIP");
  });

  it("composeHash muda quando um campo relevante muda e não contém segredos", () => {
    const firstPlan = makePlan();
    const secondPlan = makePlan({ runId: "run-compose-2" });
    const first = generateStagingCompose(request(firstPlan));
    const second = generateStagingCompose(request(secondPlan));

    expect(first.composeHash).not.toBe(second.composeHash);
    expect(first.serialized).not.toContain("super-secret");
    expect(first.serialized).not.toContain("password");
    expect(first.serialized).toBe(serializeStagingCompose(first.document!));
    expect(stableStringify(first.document)).toBe(first.serialized);
    expect(Object.keys(first.document!)).toEqual(["name", "services", "networks", "volumes"]);
    expect(first.document).not.toHaveProperty("planHash");
    expect(first.document).not.toHaveProperty("environmentReferences");
  });

  it("não executa Docker, não adquire lease e não escreve arquivos", () => {
    const plan = makePlan();
    const result = generateStagingCompose(request(plan));
    expect(result.ok).toBe(true);
    // O módulo é puro: não importa fs, child_process, Docker ou repositórios.
  });
});
