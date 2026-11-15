import { execFile } from "node:child_process";
import { DryRunStagingPlanUseCase } from "./dry-run-staging-plan.use-case";
import { StagingPortLeaseService } from "./staging-port-lease.service";
import type { Project } from "../domain/project.entity";
import type { ProjectRepository } from "../domain/project.repository";
import type {
  StagingContextCollectionResult,
  StagingContextCollector,
  StagingContextCollectRequest,
  StagingContextSnapshot,
} from "../domain/staging-context";
import type { StagingProjectConfig } from "../domain/staging-planner";
import type { StagingConfigLoader, StagingConfigLoadResult } from "../domain/persisted-staging-config";

jest.mock("node:child_process", () => ({ execFile: jest.fn() }));

class FakeProjectRepository implements ProjectRepository {
  project: Project | null = { id: "project-1", containerName: "korrelo-project-1", assignedPort: 3000 } as Project;
  fail = false;
  async findAll(): Promise<Project[]> {
    return this.project ? [this.project] : [];
  }
  async findById(): Promise<Project | null> {
    if (this.fail) throw new Error("db indisponível");
    return this.project;
  }
  async findByCustomDomain(): Promise<Project | null> {
    return null;
  }
  async findByRepoUrl(): Promise<Project[]> {
    return this.project ? [this.project] : [];
  }
  async save(project: Project): Promise<Project> {
    return project;
  }
  async delete(): Promise<void> {}
}

class FakeContextCollector implements StagingContextCollector {
  calls: StagingContextCollectRequest[] = [];
  result: StagingContextCollectionResult = { ok: true, snapshot: makeSnapshot(), issues: [] };
  throws = false;
  async collect(request: StagingContextCollectRequest): Promise<StagingContextCollectionResult> {
    this.calls.push(request);
    if (this.throws) throw new Error("coleta falhou");
    return this.result;
  }
}

class FakeConfigLoader implements StagingConfigLoader {
  calls: string[] = [];
  result: StagingConfigLoadResult = {
    ok: true,
    legacy: false,
    config: makeConfig(),
    dependencies: [],
    issues: [],
  };
  async load(projectId: string): Promise<StagingConfigLoadResult> {
    this.calls.push(projectId);
    return this.result;
  }
}

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

function makeSnapshot(overrides: Partial<StagingContextSnapshot> = {}): StagingContextSnapshot {
  return {
    production: {
      volumes: ["uploads-data", "db-data"],
      networks: ["korrelo-shared", "korrelo-project-1_default"],
      databaseTargets: [{ scheme: "postgresql", host: "db", port: 5432, database: "app" }],
      secretFingerprints: ["prod-fingerprint"],
      hostPorts: [3000],
    },
    host: {
      availableCpu: 2,
      availableMemoryMb: 2048,
      freeDiskMb: 8192,
      activeEnvironments: 0,
      maxConcurrentEnvironments: 1,
      maxTtlMinutes: 240,
      portCandidates: [4101, 4102],
      unavailablePorts: [],
    },
    warnings: ["contexto de teste"],
    ...overrides,
  };
}

function makeInput(overrides: Partial<Parameters<DryRunStagingPlanUseCase["execute"]>[0]> = {}) {
  return {
    projectId: "project-1",
    config: makeConfig(),
    dependencies: [],
    portCandidates: [4101, 4102],
    ...overrides,
  };
}

describe("DryRunStagingPlanUseCase (P1A)", () => {
  it("configuração ausente retorna legado sem consultar host/Docker", async () => {
    const projects = new FakeProjectRepository();
    const collector = new FakeContextCollector();
    const useCase = new DryRunStagingPlanUseCase(projects, collector);

    const result = await useCase.execute({ projectId: "project-1", config: null, portCandidates: [] });

    expect(result.ok).toBe(true);
    expect(result.legacy).toBe(true);
    expect(result.plan).toBeNull();
    expect(collector.calls).toHaveLength(0);
  });

  it("projeto inexistente falha de forma estruturada", async () => {
    const projects = new FakeProjectRepository();
    projects.project = null;
    const collector = new FakeContextCollector();
    const useCase = new DryRunStagingPlanUseCase(projects, collector);

    const result = await useCase.execute(makeInput());

    expect(result.ok).toBe(false);
    expect(result.issues[0].code).toBe("STAGING_PROJECT_NOT_FOUND");
    expect(collector.calls).toHaveLength(0);
  });

  it("falha ao ler o projeto é erro de contexto, não fallback", async () => {
    const projects = new FakeProjectRepository();
    projects.fail = true;
    const useCase = new DryRunStagingPlanUseCase(projects, new FakeContextCollector());

    const result = await useCase.execute(makeInput());

    expect(result.ok).toBe(false);
    expect(result.issues[0].code).toBe("STAGING_CONTEXT_UNAVAILABLE");
  });

  it("configuração isolada válida retorna plano usando apenas contexto coletado", async () => {
    const projects = new FakeProjectRepository();
    const collector = new FakeContextCollector();
    const useCase = new DryRunStagingPlanUseCase(projects, collector);

    const result = await useCase.execute(makeInput());

    expect(result.ok).toBe(true);
    expect(result.legacy).toBe(false);
    expect(result.plan?.app.hostBind).toBe("127.0.0.1:4101");
    expect(result.plan?.network.sharedNetwork).toBe(false);
    expect(collector.calls).toHaveLength(1);
    expect(collector.calls[0]).toMatchObject({
      projectId: "project-1",
      portCandidates: [4101, 4102],
      maxConcurrentEnvironments: 1,
      maxTtlMinutes: 240,
    });
    expect(result.contextWarnings).toEqual(["contexto de teste"]);
  });

  it("dry-run com configuração persistida carrega via loader interno", async () => {
    const loader = new FakeConfigLoader();
    loader.result = {
      ok: true,
      legacy: false,
      config: makeConfig(),
      dependencies: [
        {
          name: "database",
          kind: "postgres",
          envKey: "DATABASE_URL",
          resources: { memoryMb: 256, cpu: 0.25, diskMb: 512 },
        },
      ],
      issues: [],
    };
    const useCase = new DryRunStagingPlanUseCase(new FakeProjectRepository(), new FakeContextCollector(), loader);

    const result = await useCase.execute({
      projectId: "project-1",
      loadPersistedConfig: true,
      portCandidates: [4101, 4102],
    });

    expect(result.ok).toBe(true);
    expect(loader.calls).toEqual(["project-1"]);
    expect(result.plan?.dependencies[0]).toMatchObject({ name: "database", kind: "postgres" });
  });

  it("configuração explícita tem precedência sobre a persistida", async () => {
    const loader = new FakeConfigLoader();
    const useCase = new DryRunStagingPlanUseCase(new FakeProjectRepository(), new FakeContextCollector(), loader);

    const result = await useCase.execute(makeInput({ loadPersistedConfig: true }));

    expect(result.ok).toBe(true);
    expect(loader.calls).toHaveLength(0);
  });

  it("loader persistido indisponível falha sem fallback", async () => {
    const useCase = new DryRunStagingPlanUseCase(new FakeProjectRepository(), new FakeContextCollector());

    const result = await useCase.execute({
      projectId: "project-1",
      loadPersistedConfig: true,
      portCandidates: [4101],
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0].code).toBe("STAGING_CONFIG_LOADER_UNAVAILABLE");
  });

  it("falha do loader persistido retorna erro estruturado", async () => {
    const loader = new FakeConfigLoader();
    loader.result = {
      ok: false,
      legacy: false,
      config: null,
      dependencies: [],
      issues: [{ code: "STAGING_CONFIG_UNAVAILABLE", field: "config", message: "db off" }],
    };
    const useCase = new DryRunStagingPlanUseCase(new FakeProjectRepository(), new FakeContextCollector(), loader);

    const result = await useCase.execute({
      projectId: "project-1",
      loadPersistedConfig: true,
      portCandidates: [4101],
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0].code).toBe("STAGING_CONFIG_UNAVAILABLE");
  });

  it("falha da coleta retorna erro estruturado e nenhum plano", async () => {
    const collector = new FakeContextCollector();
    collector.result = {
      ok: false,
      snapshot: null,
      issues: [{ code: "STAGING_CONTEXT_UNAVAILABLE", field: "docker", message: "docker off" }],
    };
    const useCase = new DryRunStagingPlanUseCase(new FakeProjectRepository(), collector);

    const result = await useCase.execute(makeInput());

    expect(result.ok).toBe(false);
    expect(result.plan).toBeNull();
    expect(result.issues[0].code).toBe("STAGING_CONTEXT_UNAVAILABLE");
  });

  it("exceção na coleta não escapa do dry-run", async () => {
    const collector = new FakeContextCollector();
    collector.throws = true;
    const useCase = new DryRunStagingPlanUseCase(new FakeProjectRepository(), collector);

    const result = await useCase.execute(makeInput());

    expect(result.ok).toBe(false);
    expect(result.issues[0].code).toBe("STAGING_CONTEXT_UNAVAILABLE");
  });

  it("configuração isolada inválida retorna erros estruturados", async () => {
    const collector = new FakeContextCollector();
    const useCase = new DryRunStagingPlanUseCase(new FakeProjectRepository(), collector);

    const result = await useCase.execute(
      makeInput({ config: { mode: "isolated", ttlMinutes: 60 } as unknown as StagingProjectConfig }),
    );

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("STAGING_CONFIG_INCOMPLETE");
  });

  it("dependência ausente/incompleta falha no planejador", async () => {
    const collector = new FakeContextCollector();
    const useCase = new DryRunStagingPlanUseCase(new FakeProjectRepository(), collector);

    const result = await useCase.execute(
      makeInput({
        dependencies: [{ name: "db", kind: "postgres", envKey: "DATABASE_URL" }],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("STAGING_CONFIG_INCOMPLETE");
    expect(collector.calls).toHaveLength(1);
  });

  it("recursos insuficientes vindos do contexto falham no planejador", async () => {
    const collector = new FakeContextCollector();
    collector.result = {
      ok: true,
      snapshot: makeSnapshot({
        host: {
          ...makeSnapshot().host,
          availableCpu: 0.1,
          availableMemoryMb: 100,
          freeDiskMb: 100,
        },
      }),
      issues: [],
    };
    const useCase = new DryRunStagingPlanUseCase(new FakeProjectRepository(), collector);

    const result = await useCase.execute(makeInput());

    expect(result.ok).toBe(false);
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("STAGING_RESOURCE_CPU");
    expect(codes).toContain("STAGING_RESOURCE_MEMORY");
    expect(codes).toContain("STAGING_RESOURCE_DISK");
  });

  it("porta indisponível no contexto falha sem abrir porta", async () => {
    const collector = new FakeContextCollector();
    collector.result = {
      ok: true,
      snapshot: makeSnapshot({
        host: { ...makeSnapshot().host, portCandidates: [4101], unavailablePorts: [4101] },
      }),
      issues: [],
    };
    const useCase = new DryRunStagingPlanUseCase(new FakeProjectRepository(), collector);

    const result = await useCase.execute(makeInput({ portCandidates: [4101] }));

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("STAGING_PORT_CONFLICT");
  });

  it("dependência de outro projeto e banco externo são validados pelo planejador", async () => {
    const collector = new FakeContextCollector();
    const useCase = new DryRunStagingPlanUseCase(new FakeProjectRepository(), collector);

    const foreign = await useCase.execute(
      makeInput({
        dependencies: [
          {
            name: "db",
            kind: "postgres",
            projectId: "other-project",
            envKey: "DATABASE_URL",
            resources: { memoryMb: 256, cpu: 0.25, diskMb: 512 },
          },
        ],
      }),
    );
    expect(foreign.ok).toBe(false);
    expect(foreign.issues.map((issue) => issue.code)).toContain("STAGING_DEPENDENCY_PROJECT_MISMATCH");

    const external = await useCase.execute(
      makeInput({
        dependencies: [
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
    expect(external.ok).toBe(true);
    expect(external.plan?.dependencies[0]).toMatchObject({
      kind: "external",
      serviceName: null,
      mode: "external",
    });
  });

  it("dry-run não adquire lease de porta", async () => {
    const acquire = jest.spyOn(StagingPortLeaseService.prototype, "acquire");
    const useCase = new DryRunStagingPlanUseCase(new FakeProjectRepository(), new FakeContextCollector());

    await useCase.execute(makeInput());

    expect(acquire).not.toHaveBeenCalled();
    acquire.mockRestore();
  });

  it("dry-run não executa processos nem altera o projeto", async () => {
    const projects = new FakeProjectRepository();
    const before = { ...projects.project };
    const useCase = new DryRunStagingPlanUseCase(projects, new FakeContextCollector());

    await useCase.execute(makeInput());

    expect(execFile).not.toHaveBeenCalled();
    expect(projects.project).toEqual(before);
  });
});
