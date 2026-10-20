import { runCommand } from "../../../infrastructure/command-runner";
import { RuntimeReconciliationService } from "./runtime-reconciliation.service";
import { Project } from "../domain/project.entity";
import { ManagedDatabase } from "../domain/managed-database.entity";
import type { ProjectRepository } from "../domain/project.repository";
import type { ManagedDatabaseRepository } from "../domain/managed-database.repository";

jest.mock("../../../infrastructure/command-runner", () => ({
  runCommand: jest.fn(),
}));

const mockedRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;

type CommandResult = Awaited<ReturnType<typeof runCommand>>;

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
    durationMs: 2,
    ...overrides,
  };
}

function inspectPayload(options: {
  memoryBytes?: number;
  image?: string;
  restartPolicy?: string;
  networks?: string[];
  ports?: string[];
}): string {
  return JSON.stringify({
    Name: "/korrelo-mesatta-8452004c",
    Config: { Image: options.image ?? "korrelo-mesatta-8452004c:commit-abc123" },
    HostConfig: {
      Memory: options.memoryBytes ?? 1757 * 1024 * 1024,
      RestartPolicy: { Name: options.restartPolicy ?? "unless-stopped" },
    },
    NetworkSettings: {
      Networks: Object.fromEntries((options.networks ?? ["korrelo-shared"]).map((n) => [n, {}])),
      Ports: Object.fromEntries((options.ports ?? ["3100/tcp"]).map((p) => [p, []])),
    },
    State: { Status: "running", Running: true },
  });
}

class FakeProjectRepository {
  projects: Project[] = [];
  saved: Project[] = [];
  async findAll(): Promise<Project[]> {
    return this.projects;
  }
  async findById(id: string): Promise<Project | null> {
    return this.projects.find((p) => p.id === id) ?? null;
  }
  async findByCustomDomain(): Promise<Project | null> {
    return null;
  }
  async findByRepoUrl(): Promise<Project[]> {
    return this.projects;
  }
  async save(project: Project): Promise<Project> {
    this.saved.push(project);
    const index = this.projects.findIndex((p) => p.id === project.id);
    if (index >= 0) this.projects[index] = project;
    else this.projects.push(project);
    return project;
  }
  async delete(): Promise<void> {}
}

class FakeDatabaseRepository {
  databases: ManagedDatabase[] = [];
  saved: ManagedDatabase[] = [];
  async findAllByProjectId(): Promise<ManagedDatabase[]> {
    return this.databases;
  }
  async save(db: ManagedDatabase): Promise<ManagedDatabase> {
    this.saved.push(db);
    return db;
  }
  async delete(): Promise<void> {}
}

/**
 * Reconciliação de runtime (Wave 2.1): LEITURA pura do Docker + metadado
 * no Core. Nenhuma operação de escrita no Docker pode acontecer aqui.
 */
describe("RuntimeReconciliationService", () => {
  let projectRepository: FakeProjectRepository;
  let databaseRepository: FakeDatabaseRepository;
  let service: RuntimeReconciliationService;

  function makeProject(_overrides: Partial<Project> = {}): Project {
    return new Project(
      "8452004c-0000-0000-0000-000000000000",
      "Mesatta",
      "https://github.com/exemplo/mesatta.git",
      JSON.stringify({
        language: "Node.js",
        framework: null,
        packageManager: "npm",
        recommendedPort: 3000,
        startCommand: "npm run start",
        buildCommand: null,
        entryPoint: null,
      }),
      "running",
      3100,
      "korrelo-mesatta-8452004c",
      true,
      true,
      null, // customDomain
      "none", // domainSslStatus
      true, // autoDeployEnabled
      "master", // deployBranch
      null, // diskLimitMb
      false, // skipStagingTest
      null, // memoryLimitMb
      null, // lastDeployStatus
      null, // currentImage
      null, // previousImage
      null, // healthcheckConfig
      null, // productionMemoryLimitMb
      null, // runtimeSnapshot
      false, // grandfathered
      null, // grandfatheredAt
      false, // runtimeDriftDetected
      null, // runtimeDriftDetails
      false, // memoryLimitReductionApproved
      null, // stagingMemoryLimitMb
      null, // stagingHealthTimeoutSeconds
      new Date(),
    );
  }

  beforeEach(() => {
    mockedRunCommand.mockReset();
    projectRepository = new FakeProjectRepository();
    databaseRepository = new FakeDatabaseRepository();
    service = new RuntimeReconciliationService(
      projectRepository as unknown as ProjectRepository,
      databaseRepository as unknown as ManagedDatabaseRepository,
    );
  });

  it("lê o limite, a imagem e a política de restart do container existente", async () => {
    projectRepository.projects = [makeProject()];
    mockedRunCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "inspect") return result({ stdout: inspectPayload({}) });
      return result({ stdout: "" });
    });

    const outcome = await service.reconcileProject(projectRepository.projects[0]);

    expect(outcome.status).toBe("reconciled");
    expect(outcome.snapshot?.memoryLimitMb).toBe(1757);
    expect(outcome.snapshot?.restartPolicy).toBe("unless-stopped");
    expect(outcome.snapshot?.image).toBe("korrelo-mesatta-8452004c:commit-abc123");
    // O Core passa a saber o limite real (fonte da verdade = Docker).
    expect(projectRepository.saved[0].productionMemoryLimitMb).toBe(1757);
    expect(projectRepository.saved[0].grandfathered).toBe(true);
  });

  it("NÃO executa NENHUMA operação de escrita no Docker", async () => {
    projectRepository.projects = [makeProject()];
    mockedRunCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "inspect") return result({ stdout: inspectPayload({}) });
      return result({ stdout: "" });
    });

    await service.reconcileAll();

    const forbidden = ["rm", "rmi", "stop", "start", "restart", "kill", "update", "run", "create", "up", "down", "exec"];
    for (const call of mockedRunCommand.mock.calls) {
      const args = (call[1] ?? []) as string[];
      expect(forbidden).not.toContain(args[0]);
    }
  });

  it("registra o limite OBSERVADO dos bancos (sem mexer neles)", async () => {
    projectRepository.projects = [makeProject()];
    databaseRepository.databases = [
      new ManagedDatabase(
        "db-1",
        "8452004c-0000-0000-0000-000000000000",
        "mongodb",
        "db",
        "korrelo",
        "senha",
        "korrelo",
        null,
        null,
        true,
        null,
        new Date(),
      ),
    ];
    mockedRunCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "inspect" && String(args[3] ?? "").includes("-db-1")) {
        return result({ stdout: inspectPayload({ memoryBytes: 879 * 1024 * 1024 }) });
      }
      if (args[0] === "inspect") return result({ stdout: inspectPayload({}) });
      return result({ stdout: "" });
    });

    const outcome = await service.reconcileProject(projectRepository.projects[0]);

    expect(outcome.databases[0].memoryLimitMb).toBe(879);
    expect(databaseRepository.saved[0].memoryLimitMb).toBe(879);
  });

  it("detecta divergência entre Core e Docker SEM alterar o container", async () => {
    // O Core tinha registrado outro limite/imagem; o Docker mostra outra coisa.
    const project = makeProject();
    projectRepository.projects = [
      project.withRuntimeObservation({
        productionMemoryLimitMb: 1024,
        runtimeSnapshot: JSON.stringify({
          name: "korrelo-mesatta-8452004c",
          memoryLimitMb: 1024,
          image: "korrelo-mesatta-8452004c:commit-antigo",
          restartPolicy: "unless-stopped",
          networks: ["korrelo-shared"],
          ports: ["3100/tcp"],
          observedAt: new Date().toISOString(),
        }),
        grandfathered: true,
        grandfatheredAt: new Date(),
        runtimeDriftDetected: false,
        runtimeDriftDetails: null,
      }),
    ];
    mockedRunCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "inspect") return result({ stdout: inspectPayload({}) });
      return result({ stdout: "" });
    });

    const outcome = await service.reconcileProject(projectRepository.projects[0]);

    expect(outcome.drift.detected).toBe(true);
    expect(outcome.drift.details.join(" ")).toContain("limite de memória");
    expect(outcome.drift.details.join(" ")).toContain("imagem");
    // Registrado, mas nada foi "corrigido" no Docker.
    expect(projectRepository.saved[0].runtimeDriftDetected).toBe(true);
  });

  it("Docker indisponível: o startup continua (nada quebra, nada é assumido)", async () => {
    projectRepository.projects = [makeProject()];
    mockedRunCommand.mockImplementation(async () => result({ timedOut: true, exitCode: null }));

    const outcome = await service.reconcileProject(projectRepository.projects[0]);

    expect(outcome.status).toBe("docker_unavailable");
    expect(outcome.snapshot).toBeNull();
    // Nenhum limite foi inventado: o Core continua sem saber (e o
    // grandfathering mantém o que já sabia).
    expect(projectRepository.saved.length).toBe(0);
    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });

  it("é idempotente: reconciliar duas vezes não muda nada", async () => {
    projectRepository.projects = [makeProject()];
    mockedRunCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "inspect") return result({ stdout: inspectPayload({}) });
      return result({ stdout: "" });
    });

    await service.reconcileProject(projectRepository.projects[0]);
    const first = projectRepository.saved[0];
    await service.reconcileProject(projectRepository.saved[0]);
    const second = projectRepository.saved[1];

    expect(second.productionMemoryLimitMb).toBe(first.productionMemoryLimitMb);
    expect(second.runtimeDriftDetected).toBe(false);
  });
});
