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
  async create(job: DeployJob): Promise<DeployJob> {
    this.jobs.set(job.id, job);
    return job;
  }
  async save(job: DeployJob): Promise<DeployJob> {
    this.jobs.set(job.id, job);
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

describe("StagingCleanupService", () => {
  const service: StagingCleanupService;
  let repo: FakeJobRepository;

  beforeEach(() => {
    mockedRunCommand.mockReset();
    repo = new FakeJobRepository();
    service = new StagingCleanupService(repo as unknown as DeployJobRepository);
  });

  it("remove o container de staging orfao (job que nao esta mais em aberto)", async () => {
    const job = DeployJob.create({ projectId: "p1", commitSha: "sha1", branch: "main", trigger: "webhook" });
    await repo.save(job.withStatus("failed"));

    mockedRunCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "ps") {
        return result({ stdout: `abc123\tkorrelo-app-staging\t${job.id}\n` });
      }
      return result();
    });

    const outcome = await service.cleanupOrphanedStagingContainers();

    expect(outcome.removed).toEqual(["korrelo-app-staging"]);
  });

  it("NÃO remove o container de um deploy que ainda está em andamento", async () => {
    const job = DeployJob.create({ projectId: "p1", commitSha: "sha1", branch: "main", trigger: "webhook" });
    await repo.save(job.withStatus("running"));

    mockedRunCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "ps") {
        return result({ stdout: `abc123\tkorrelo-app-staging\t${job.id}\n` });
      }
      return result();
    });

    const outcome = await service.cleanupOrphanedStagingContainers();

    expect(outcome.removed).toEqual([]);
    expect(outcome.kept).toEqual(["korrelo-app-staging"]);
  });

  it("não faz nada quando o Docker não responde", async () => {
    mockedRunCommand.mockImplementation(async () => result({ timedOut: true, exitCode: null }));

    const outcome = await service.cleanupOrphanedStagingContainers();

    expect(outcome.removed).toEqual([]);
    expect(outcome.kept).toEqual([]);
  });
});
