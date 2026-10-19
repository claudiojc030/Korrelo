import { runCommand } from "../../../infrastructure/command-runner";
import { StagingCleanupService } from "./staging-cleanup.service";
import { DeployJob } from "../domain/deploy-job.entity";
import type { DeployJobRepository } from "../domain/deploy-job.repository";
import type { DeployJobStatus } from "../domain/deploy-job.entity";

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
    durationMs: 3,
    ...overrides,
  };
}

class FakeJobRepository implements DeployJobRepository {
  readonly jobs = new Map<string, DeployJob>();
  saved: DeployJob[] = [];
  async create(job: DeployJob): Promise<DeployJob> {
    this.jobs.set(job.id, job);
    return job;
  }
  async save(job: DeployJob): Promise<DeployJob> {
    this.jobs.set(job.id, job);
    this.saved.push(job);
    return job;
  }
  async findById(id: string): Promise<DeployJob | null> {
    return this.jobs.get(id) ?? null;
  }
  async findNextQueued(): Promise<DeployJob | null> {
    return null;
  }
  async findOpenByProject(): Promise<DeployJob | null> {
    return null;
  }
  async findByProjectAndCommit(): Promise<DeployJob | null> {
    return null;
  }
  async findAllByStatus(): Promise<DeployJob[]> {
    return [];
  }
  async findLatestByProject(): Promise<DeployJob | null> {
    return null;
  }
  async findRecent(): Promise<DeployJob[]> {
    return [];
  }
  async countByStatus(_status: DeployJobStatus): Promise<number> {
    return 0;
  }
}

/**
 * STARTUP 100% READ-ONLY (Wave 2.1 - ajuste final).
 *
 * O boot do Korrelo pode LER o Docker (ps/inspect/stats) e registrar
 * metadado no Core, mas NUNCA escreve no Docker: nada de rm/stop/restart/
 * update/compose up/down/rm.
 */
describe("StagingCleanupService", () => {
  let service: StagingCleanupService;
  let repo: FakeJobRepository;

  beforeEach(() => {
    mockedRunCommand.mockReset();
    repo = new FakeJobRepository();
    service = new StagingCleanupService(repo as unknown as DeployJobRepository);
  });

  function dockerCalls(): { command: string; args: string[] }[] {
    return mockedRunCommand.mock.calls.map((call) => ({
      command: String(call[0]),
      args: (call[1] ?? []) as string[],
    }));
  }

  function destructiveCalls(): { command: string; args: string[] }[] {
    const forbidden = ["rm", "rmi", "stop", "start", "restart", "kill", "update", "run", "create", "up", "down", "exec"];
    return dockerCalls().filter(
      (call) => call.command === "docker" && forbidden.includes(call.args[0]),
    );
  }

  it("1) startup com projeto existente: NENHUM comando destrutivo no Docker", async () => {
    mockedRunCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "ps") return result({ stdout: "" });
      return result();
    });

    await service.onModuleInit();

    expect(destructiveCalls()).toEqual([]);
  });

  it("2) startup com staging órfão: DETECTA, mas NÃO remove", async () => {
    const job = DeployJob.create({ projectId: "p1", commitSha: "sha1", branch: "main", trigger: "webhook" });
    await repo.save(job.withStatus("failed"));

    mockedRunCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "ps") {
        return result({ stdout: `abc123\tkorrelo-app-staging\t${job.id}\n` });
      }
      return result();
    });

    await service.onModuleInit();

    // Detectou...
    const detected = await service.detectStagingContainers();
    expect(detected).toHaveLength(1);
    expect(detected[0].orphaned).toBe(true);
    // ...mas NÃO removeu nada.
    expect(destructiveCalls()).toEqual([]);
    // E registrou o job como pendente de limpeza (metadado no Core).
    expect(repo.saved.some((saved) => (saved.errorMessage ?? "").includes("Pendente de limpeza"))).toBe(true);
  });

  it("3) startup com Docker indisponível: segue normalmente (sem quebrar o boot)", async () => {
    mockedRunCommand.mockImplementation(async () => result({ timedOut: true, exitCode: null }));

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(destructiveCalls()).toEqual([]);
  });

  it("4) cleanup EXPLICITO remove somente o staging efêmero confirmado", async () => {
    const job = DeployJob.create({ projectId: "p1", commitSha: "sha1", branch: "main", trigger: "webhook" });
    await repo.save(job.withStatus("interrupted"));

    mockedRunCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "ps") {
        return result({ stdout: `abc123\tkorrelo-app-staging\t${job.id}\n` });
      }
      return result();
    });

    const outcome = await service.cleanupOrphanedStaging();

    expect(outcome.removed).toEqual(["korrelo-app-staging"]);
    const removals = dockerCalls().filter((call) => call.command === "docker" && call.args[0] === "rm");
    expect(removals).toHaveLength(1);
  });

  it("5) cleanup EXPLICITO NUNCA remove container de produção", async () => {
    // Container de produção: sem a label efêmera (nem entra na lista) e
    // nome que não é de container de teste.
    mockedRunCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "ps") {
        // Saída forçada: alguém rotulou um container que NÃO é de teste.
        return result({ stdout: "def456\tkorrelo-mesatta-8452004c\t\n" });
      }
      return result();
    });

    const outcome = await service.cleanupOrphanedStaging();

    expect(outcome.removed).toEqual([]);
    expect(outcome.skipped).toEqual(["korrelo-mesatta-8452004c"]);
    expect(destructiveCalls()).toEqual([]);
  });

  it("5b) cleanup explícito preserva o container de teste de um deploy em andamento", async () => {
    const job = DeployJob.create({ projectId: "p1", commitSha: "sha1", branch: "main", trigger: "webhook" });
    await repo.save(job.withStatus("running"));

    mockedRunCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "ps") {
        return result({ stdout: `abc123\tkorrelo-app-staging\t${job.id}\n` });
      }
      return result();
    });

    const outcome = await service.cleanupOrphanedStaging();

    expect(outcome.removed).toEqual([]);
    expect(outcome.kept).toEqual(["korrelo-app-staging"]);
    expect(destructiveCalls()).toEqual([]);
  });
});
