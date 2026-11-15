import { runCommand } from "../../../infrastructure/command-runner";
import type { Project } from "../domain/project.entity";
import type { ProjectRepository } from "../domain/project.repository";
import type { ManagedDatabase } from "../domain/managed-database.entity";
import type { ManagedDatabaseRepository } from "../domain/managed-database.repository";
import type { EnvVar } from "../domain/env-var.entity";
import type { EnvVarRepository } from "../domain/env-var.repository";
import type {
  StagingContextCollectRequest,
  StagingHostMetricsReader,
  StagingHostMetricsSnapshot,
  StagingPortProbe,
  StagingRuntimeInventory,
  StagingRuntimeInventorySnapshot,
} from "../domain/staging-context";
import {
  DockerStagingRuntimeInventory,
  ReadOnlyStagingContextCollector,
} from "./read-only-staging-context.collector";

jest.mock("../../../infrastructure/command-runner", () => ({
  runCommand: jest.fn(),
}));

const mockedRunCommand = runCommand as unknown as jest.Mock;

class FakeProjectRepository implements ProjectRepository {
  project: Project | null = {
    id: "project-1",
    containerName: "korrelo-project-1",
    assignedPort: 3000,
  } as Project;
  fail = false;
  async findAll(): Promise<Project[]> {
    if (this.fail) throw new Error("db indisponível");
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

class FakeDatabaseRepository implements ManagedDatabaseRepository {
  databases: ManagedDatabase[] = [];
  fail = false;
  async findAllByProjectId(): Promise<ManagedDatabase[]> {
    if (this.fail) throw new Error("db indisponível");
    return this.databases;
  }
  async save(db: ManagedDatabase): Promise<ManagedDatabase> {
    return db;
  }
  async delete(): Promise<void> {}
}

class FakeEnvVarRepository implements EnvVarRepository {
  vars: EnvVar[] = [];
  fail = false;
  async findByProjectId(): Promise<EnvVar[]> {
    if (this.fail) throw new Error("db indisponível");
    return this.vars;
  }
  async replaceAll(_projectId: string, vars: { key: string; value: string }[]): Promise<EnvVar[]> {
    return vars.map((v, index) => ({ id: String(index), projectId: _projectId, key: v.key, value: v.value, createdAt: new Date() }));
  }
  async upsertOne(): Promise<void> {}
}

class FakeRuntimeInventory implements StagingRuntimeInventory {
  snapshot: StagingRuntimeInventorySnapshot = { activeStagingEnvironments: 1, unavailablePorts: [3000, 4000] };
  fail = false;
  async inspect(): Promise<StagingRuntimeInventorySnapshot> {
    if (this.fail) throw new Error("docker indisponível");
    return this.snapshot;
  }
}

class FakeHostMetrics implements StagingHostMetricsReader {
  snapshot: StagingHostMetricsSnapshot = {
    availableCpu: 4,
    availableMemoryMb: 2048,
    freeDiskMb: 8192,
  };
  fail = false;
  async read(): Promise<StagingHostMetricsSnapshot> {
    if (this.fail) throw new Error("host indisponível");
    return this.snapshot;
  }
}

class FakePortProbe implements StagingPortProbe {
  unavailable: number[] = [4102];
  fail = false;
  calls: number[][] = [];
  async findUnavailable(ports: number[]): Promise<number[]> {
    this.calls.push(ports);
    if (this.fail) throw new Error("porta indisponível");
    return this.unavailable.filter((port) => ports.includes(port));
  }
}

const request: StagingContextCollectRequest = {
  projectId: "project-1",
  portCandidates: [4101, 4102],
  maxConcurrentEnvironments: 1,
  maxTtlMinutes: 240,
};

function build() {
  const projects = new FakeProjectRepository();
  const databases = new FakeDatabaseRepository();
  const envVars = new FakeEnvVarRepository();
  const runtime = new FakeRuntimeInventory();
  const host = new FakeHostMetrics();
  const portProbe = new FakePortProbe();
  const collector = new ReadOnlyStagingContextCollector(
    projects,
    databases,
    envVars,
    runtime,
    host,
    portProbe,
  );
  return { projects, databases, envVars, runtime, host, portProbe, collector };
}

function seed(databases: FakeDatabaseRepository, envVars: FakeEnvVarRepository): void {
  databases.databases = [
    {
      type: "postgres",
      serviceName: "db",
      databaseName: "app",
      password: "db-secret-value",
      connectionString: null,
    } as ManagedDatabase,
    {
      type: "custom",
      serviceName: null,
      databaseName: null,
      password: null,
      connectionString: "postgresql://user:external-secret@external:5432/prod",
    } as ManagedDatabase,
  ];
  envVars.vars = [
    { key: "API_SECRET", value: "env-secret-value" },
    { key: "PUBLIC_URL", value: "https://example.com" },
    { key: "MONGO_URI", value: "mongodb://user:mongo-secret@mongo:27017/db" },
  ] as EnvVar[];
}

describe("ReadOnlyStagingContextCollector (P1A)", () => {
  beforeEach(() => {
    mockedRunCommand.mockReset();
  });

  it("coleta recursos, volumes, redes, bancos, fingerprints e portas sem expor segredos", async () => {
    const { databases, envVars, collector } = build();
    seed(databases, envVars);

    const result = await collector.collect(request);

    expect(result.ok).toBe(true);
    const snapshot = result.snapshot!;
    expect(snapshot.host).toMatchObject({
      availableCpu: 4,
      availableMemoryMb: 2048,
      freeDiskMb: 8192,
      activeEnvironments: 1,
      maxConcurrentEnvironments: 1,
      maxTtlMinutes: 240,
      portCandidates: [4101, 4102],
      unavailablePorts: [3000, 4000, 4102],
    });
    expect(snapshot.production.volumes).toEqual(["uploads-data", "db-data"]);
    expect(snapshot.production.networks).toEqual(["korrelo-shared", "korrelo-project-1_default"]);
    expect(snapshot.production.databaseTargets).toEqual(
      expect.arrayContaining([
        { scheme: "postgresql", host: "db", port: 5432, database: "app" },
        { scheme: "postgresql", host: "external", port: 5432, database: "prod" },
        { scheme: "mongodb", host: "mongo", port: 27017, database: "db" },
      ]),
    );
    expect(snapshot.production.hostPorts).toEqual([3000]);
    expect(snapshot.production.secretFingerprints).toHaveLength(4);
    expect(JSON.stringify(snapshot)).not.toContain("db-secret-value");
    expect(JSON.stringify(snapshot)).not.toContain("external-secret");
    expect(JSON.stringify(snapshot)).not.toContain("env-secret-value");
    expect(JSON.stringify(snapshot)).not.toContain("mongo-secret");
    expect(snapshot.warnings.length).toBeGreaterThan(0);
  });

  it("projeto inexistente falha fechado", async () => {
    const { projects, collector } = build();
    projects.project = null;

    const result = await collector.collect(request);

    expect(result.ok).toBe(false);
    expect(result.issues[0].code).toBe("STAGING_PROJECT_NOT_FOUND");
  });

  it("falha do repositório não vira fallback", async () => {
    const { projects, collector } = build();
    projects.fail = true;

    const result = await collector.collect(request);

    expect(result.ok).toBe(false);
    expect(result.issues[0].code).toBe("STAGING_CONTEXT_UNAVAILABLE");
  });

  it("Docker indisponível bloqueia o dry-run", async () => {
    const { runtime, collector } = build();
    runtime.fail = true;

    const result = await collector.collect(request);

    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({
      code: "STAGING_CONTEXT_UNAVAILABLE",
      field: "docker",
    });
  });

  it("falha ao sondar portas bloqueia o dry-run", async () => {
    const { portProbe, collector } = build();
    portProbe.fail = true;

    const result = await collector.collect(request);

    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({
      code: "STAGING_CONTEXT_UNAVAILABLE",
      field: "ports",
    });
  });

  it("métricas de host incompletas bloqueiam o dry-run", async () => {
    const { host, collector } = build();
    host.snapshot = { availableCpu: null, availableMemoryMb: null, freeDiskMb: null };

    const result = await collector.collect(request);

    expect(result.ok).toBe(false);
    const fields = result.issues.map((issue) => issue.field);
    expect(fields).toContain("host.availableCpu");
    expect(fields).toContain("host.availableMemoryMb");
    expect(fields).toContain("host.freeDiskMb");
  });

  it("inventário de ambientes inválido bloqueia o dry-run", async () => {
    const { runtime, collector } = build();
    runtime.snapshot = { activeStagingEnvironments: -1, unavailablePorts: [] };

    const result = await collector.collect(request);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.field)).toContain("docker.activeStagingEnvironments");
  });
});

describe("DockerStagingRuntimeInventory", () => {
  beforeEach(() => {
    mockedRunCommand.mockReset();
  });

  it("usa somente docker ps -a read-only", async () => {
    mockedRunCommand.mockResolvedValue({
      stdout:
        "running\ttrue\t127.0.0.1:3000->3000/tcp\n" +
        "exited\ttrue\t127.0.0.1:4100->4100/tcp\n" +
        "running\tfalse\t127.0.0.1:3200->3200/tcp\n",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      truncated: false,
      durationMs: 1,
    });

    const snapshot = await new DockerStagingRuntimeInventory().inspect();

    expect(snapshot).toEqual({ activeStagingEnvironments: 1, unavailablePorts: [3000, 4100, 3200] });
    const [command, args] = mockedRunCommand.mock.calls[0];
    expect(command).toBe("docker");
    expect(args[0]).toBe("ps");
    expect(args).not.toContain("rm");
    expect(args).not.toContain("create");
    expect(args).not.toContain("start");
    expect(args).not.toContain("stop");
    expect(args).not.toContain("down");
  });

  it("falha do Docker é propagada para o coletor", async () => {
    mockedRunCommand.mockResolvedValue({
      stdout: "",
      stderr: "cannot connect",
      exitCode: 1,
      signal: null,
      timedOut: false,
      truncated: false,
      durationMs: 1,
    });

    await expect(new DockerStagingRuntimeInventory().inspect()).rejects.toThrow("Docker indisponível");
  });
});
