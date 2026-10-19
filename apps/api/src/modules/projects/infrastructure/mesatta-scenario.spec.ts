import { runCommand } from "../../../infrastructure/command-runner";
import { CompatibilityDryRunService } from "./compatibility-dry-run.service";
import { ResourcePreflightService } from "./resource-preflight.service";
import { RuntimeReconciliationService } from "./runtime-reconciliation.service";
import { StagingCleanupService } from "./staging-cleanup.service";
import { Project } from "../domain/project.entity";
import { ManagedDatabase } from "../domain/managed-database.entity";
import type { ProjectRepository } from "../domain/project.repository";
import type { ManagedDatabaseRepository } from "../domain/managed-database.repository";
import type { DeployJobRepository } from "../domain/deploy-job.repository";

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

function inspectPayload(memoryMb: number, image: string, ports: string[]): string {
  return JSON.stringify({
    Name: "/container",
    Config: { Image: image },
    HostConfig: { Memory: memoryMb * 1024 * 1024, RestartPolicy: { Name: "unless-stopped" } },
    NetworkSettings: {
      Networks: { "korrelo-shared": {} },
      Ports: Object.fromEntries(ports.map((p) => [p, []])),
    },
    State: { Status: "running", Running: true },
  });
}

/**
 * CENÁRIO REAL DA VPS (Wave 2.1, Objetivo 8).
 *
 * Host: 1 vCPU, 4 GB RAM, 2 GB swap.
 *   Mesatta   → app 1757 MB (uso ~803 MB) + MongoDB 879 MB
 *   Evolution → app 1757 MB + Postgres 586 MB + Redis 586 MB
 *
 * O que precisa ser garantido:
 *  1. atualizar o Korrelo não altera nenhum limite;
 *  2. o Mesatta continua com 1757 MB e o Mongo com 879 MB;
 *  3. a fórmula nova (que daria ~486 MB) NÃO força downgrade;
 *  4. o deploy do Mesatta é bloqueado se não houver headroom pra staging;
 *  5. a produção permanece "running";
 *  6. nenhum container é recriado.
 */
const MESATTA_ID = "8452004c-0000-0000-0000-000000000000";
const EVOLUTION_ID = "f848a858-0000-0000-0000-000000000000";

function makeProject(params: {
  id: string;
  name: string;
  containerName: string;
  port: number;
  productionLimitMb: number;
  image: string;
  branch: string;
}): Project {
  return new Project(
    params.id,
    params.name,
    `https://github.com/exemplo/${params.name.toLowerCase()}.git`,
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
    params.port,
    params.containerName,
    true,
    true,
    null,
    "none",
    true,
    params.branch,
    null,
    false,
    null,
    null,
    params.image,
    null,
    null,
    // productionMemoryLimitMb (observado no Docker)
    params.productionLimitMb,
    // runtimeSnapshot
    JSON.stringify({
      name: params.containerName,
      memoryLimitMb: params.productionLimitMb,
      image: params.image,
      restartPolicy: "unless-stopped",
      networks: ["korrelo-shared"],
      ports: [`${params.port}/tcp`],
      observedAt: new Date().toISOString(),
    }),
    true,
    new Date(),
    false,
    null,
    false,
    new Date(),
  );
}

function makeDatabase(params: {
  id: string;
  projectId: string;
  type: "postgres" | "redis" | "mongodb";
  serviceName: string;
  memoryLimitMb: number;
}): ManagedDatabase {
  return new ManagedDatabase(
    params.id,
    params.projectId,
    params.type,
    params.serviceName,
    "korrelo",
    "senha",
    "korrelo",
    null,
    null,
    params.type === "redis" ? false : true,
    params.memoryLimitMb,
    new Date(),
  );
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
    return project;
  }
  async delete(): Promise<void> {}
}

class FakeDatabaseRepository {
  databases: ManagedDatabase[] = [];
  async findAllByProjectId(projectId: string): Promise<ManagedDatabase[]> {
    return this.databases.filter((db) => db.projectId === projectId);
  }
  async save(db: ManagedDatabase): Promise<ManagedDatabase> {
    return db;
  }
  async delete(): Promise<void> {}
}

describe("Cenário real da VPS: Mesatta + Evolution (Wave 2.1)", () => {
  let projectRepository: FakeProjectRepository;
  let databaseRepository: FakeDatabaseRepository;

  beforeEach(() => {
    mockedRunCommand.mockReset();
    projectRepository = new FakeProjectRepository();
    databaseRepository = new FakeDatabaseRepository();

    projectRepository.projects = [
      makeProject({
        id: MESATTA_ID,
        name: "Mesatta",
        containerName: "korrelo-mesatta-8452004c",
        port: 3100,
        productionLimitMb: 1757,
        image: "korrelo-mesatta-8452004c:commit-mesatta",
        branch: "master",
      }),
      makeProject({
        id: EVOLUTION_ID,
        name: "Evolution API",
        containerName: "korrelo-evolution-api-whatsapp-f848a858",
        port: 3200,
        productionLimitMb: 1757,
        image: "korrelo-evolution-api-whatsapp-f848a858:commit-evolution",
        branch: "main",
      }),
    ];

    databaseRepository.databases = [
      makeDatabase({
        id: "db-mesatta",
        projectId: MESATTA_ID,
        type: "mongodb",
        serviceName: "db",
        memoryLimitMb: 879,
      }),
      makeDatabase({
        id: "db-evolution-pg",
        projectId: EVOLUTION_ID,
        type: "postgres",
        serviceName: "db",
        memoryLimitMb: 586,
      }),
      makeDatabase({
        id: "db-evolution-redis",
        projectId: EVOLUTION_ID,
        type: "redis",
        serviceName: "db-redis",
        memoryLimitMb: 586,
      }),
    ];

    // Docker responde com o estado real da VPS.
    mockedRunCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "inspect") {
        const target = String(args[3] ?? "");
        if (target.includes("korrelo-mesatta-8452004c-db-1")) {
          return result({ stdout: inspectPayload(879, "mongo:7", []) });
        }
        if (target.includes("korrelo-evolution-api-whatsapp-f848a858-db-1")) {
          return result({ stdout: inspectPayload(586, "postgres:16-alpine", []) });
        }
        if (target.includes("korrelo-evolution-api-whatsapp-f848a858-db-redis-1")) {
          return result({ stdout: inspectPayload(586, "redis:7-alpine", []) });
        }
        if (target.includes("mesatta")) {
          return result({ stdout: inspectPayload(1757, "korrelo-mesatta-8452004c:commit-mesatta", ["3100/tcp"]) });
        }
        return result({ stdout: inspectPayload(1757, "korrelo-evolution-api-whatsapp-f848a858:commit-evolution", ["3200/tcp"]) });
      }
      if (args[0] === "ps") return result({ stdout: "app\n" });
      if (args[0] === "df") {
        return result({ stdout: "Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 50000000 25000000 25000000 50% /\n" });
      }
      return result();
    });
  });

  function buildDryRun(preflight: ResourcePreflightService): CompatibilityDryRunService {
    return new CompatibilityDryRunService(
      projectRepository as unknown as ProjectRepository,
      databaseRepository as unknown as ManagedDatabaseRepository,
      new RuntimeReconciliationService(
        projectRepository as unknown as ProjectRepository,
        databaseRepository as unknown as ManagedDatabaseRepository,
      ),
      preflight,
    );
  }

  it("atualizar o Korrelo NÃO altera nenhum limite (reconciliação é read-only)", async () => {
    const reconciliation = new RuntimeReconciliationService(
      projectRepository as unknown as ProjectRepository,
      databaseRepository as unknown as ManagedDatabaseRepository,
    );

    await reconciliation.reconcileAll();

    // Nenhuma operação de escrita no Docker.
    const forbidden = ["rm", "rmi", "stop", "start", "restart", "update", "run", "create", "up", "down"];
    for (const call of mockedRunCommand.mock.calls) {
      const args = (call[1] ?? []) as string[];
      expect(forbidden).not.toContain(args[0]);
    }

    // Os limites observados foram apenas REGISTRADOS.
    const mesatta = projectRepository.saved.find((p) => p.id === MESATTA_ID);
    expect(mesatta?.productionMemoryLimitMb).toBe(1757);
    expect(mesatta?.status).toBe("running");
  });

  it("Mesatta continua com 1757 MB e o Mongo com 879 MB (sem downgrade forçado)", async () => {
    const preflight = { check: async () => ({ ok: true, reason: null, metrics: {} }) } as unknown as ResourcePreflightService;
    const report = await buildDryRun(preflight).run();

    const mesatta = report.projects.find((p) => p.projectId === MESATTA_ID);
    expect(mesatta?.currentProductionLimitMb).toBe(1757);
    // A fórmula nova daria menos - mas o efetivo é o observado.
    expect(mesatta?.calculatedNewLimitMb).toBeLessThan(1757);
    expect(mesatta?.effectiveLimitMb).toBe(1757);
    expect(mesatta?.grandfathered).toBe(true);
    expect(mesatta?.wouldReduceLimit).toBe(false);
    // O Mongo mantém o limite observado.
    expect(mesatta?.databases[0].currentLimitMb).toBe(879);
    expect(mesatta?.databases[0].effectiveLimitMb).toBe(879);
    expect(mesatta?.databases[0].preserved).toBe(true);
  });

  it("Evolution mantém app, Postgres e Redis", async () => {
    const preflight = { check: async () => ({ ok: true, reason: null, metrics: {} }) } as unknown as ResourcePreflightService;
    const report = await buildDryRun(preflight).run();

    const evolution = report.projects.find((p) => p.projectId === EVOLUTION_ID);
    expect(evolution?.effectiveLimitMb).toBe(1757);
    expect(evolution?.databases.map((d) => d.effectiveLimitMb)).toEqual([586, 586]);
    expect(evolution?.databases.every((d) => d.preserved)).toBe(true);
  });

  it("sem headroom: o deploy é bloqueado e a produção continua rodando", async () => {
    const preflight = {
      check: async () => ({
        ok: false,
        reason: "memória livre insuficiente para o build",
        metrics: {},
      }),
    } as unknown as ResourcePreflightService;

    const report = await buildDryRun(preflight).run();

    const mesatta = report.projects.find((p) => p.projectId === MESATTA_ID);
    expect(mesatta?.deployPossibleNow).toBe(false);
    expect(mesatta?.reason).toContain("memória");
    // A produção segue "running" e com o limite intacto.
    expect(mesatta?.status).toBe("running");
    expect(mesatta?.effectiveLimitMb).toBe(1757);
  });

  it("o dry-run NÃO altera nada (nem Core, nem Docker)", async () => {
    const preflight = { check: async () => ({ ok: true, reason: null, metrics: {} }) } as unknown as ResourcePreflightService;
    const service = buildDryRun(preflight);
    const projectsBefore = JSON.stringify(projectRepository.projects);
    const callsBefore = mockedRunCommand.mock.calls.length;

    await service.run();

    expect(JSON.stringify(projectRepository.projects)).toBe(projectsBefore);
    expect(projectRepository.saved.length).toBe(0);
    // Só leituras de Docker (inspect/ps/df).
    for (const call of mockedRunCommand.mock.calls.slice(callsBefore)) {
      const args = (call[1] ?? []) as string[];
      expect(["inspect", "ps", "df"]).toContain(args[0]);
    }
  });

  it("o overcommit pré-existente é REPORTADO (sem corrigir nada)", async () => {
    const preflight = { check: async () => ({ ok: true, reason: null, metrics: {} }) } as unknown as ResourcePreflightService;
    const report = await buildDryRun(preflight).run();

    // 1757 (Mesatta) + 1757 (Evolution) = 3514 MB de app numa VPS de 4096 MB,
    // só com os apps (sem contar os bancos).
    expect(report.productionReservedMb).toBe(3514);
    expect(report.hostTotalMemMb).toBeGreaterThan(0);
  });

  it("startup com Mesatta + Mongo + Evolution + staging órfão: ZERO escritas no Docker", async () => {
    // Simula um container de teste órfão junto com a produção no ar.
    mockedRunCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "ps" && args.includes("-a")) {
        return result({
          stdout: "fff999\tkorrelo-mesatta-8452004c-staging\tjob-orfão-123\n",
        });
      }
      if (args[0] === "inspect") {
        const target = String(args[3] ?? "");
        if (target.includes("-db-1")) {
          return result({ stdout: inspectPayload(879, "mongo:7", []) });
        }
        if (target.includes("mesatta")) {
          return result({
            stdout: inspectPayload(1757, "korrelo-mesatta-8452004c:commit-mesatta", ["3100/tcp"]),
          });
        }
        return result({
          stdout: inspectPayload(1757, "korrelo-evolution-api-whatsapp-f848a858:commit-evolution", ["3200/tcp"]),
        });
      }
      if (args[0] === "ps") return result({ stdout: "app\n" });
      if (args[0] === "df") {
        return result({
          stdout: "Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 50000000 25000000 25000000 50% /\n",
        });
      }
      return result();
    });

    // Reconciliação (boot) + varredura de staging (boot).
    const reconciliation = new RuntimeReconciliationService(
      projectRepository as unknown as ProjectRepository,
      databaseRepository as unknown as ManagedDatabaseRepository,
    );
    await reconciliation.reconcileAll();

    const stagingCleanup = new StagingCleanupService({
      findById: async () => null,
    } as unknown as DeployJobRepository);
    await stagingCleanup.onModuleInit();

    // NENHUMA operação de escrita no Docker durante o boot.
    const forbidden = ["rm", "rmi", "stop", "start", "restart", "kill", "update", "run", "create", "up", "down", "exec"];
    for (const call of mockedRunCommand.mock.calls) {
      const args = (call[1] ?? []) as string[];
      expect(forbidden).not.toContain(args[0]);
    }

    // E a produção continua como estava.
    const mesatta = projectRepository.saved.find((p) => p.id === MESATTA_ID);
    expect(mesatta?.productionMemoryLimitMb).toBe(1757);
    expect(mesatta?.status).toBe("running");
    expect(mesatta?.containerName).toBe("korrelo-mesatta-8452004c");
  });
});
