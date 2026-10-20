import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DeployJob, type DeployJobStatus } from "../domain/deploy-job.entity";
import type { DeployJobRepository } from "../domain/deploy-job.repository";
import type { ProjectRepository } from "../domain/project.repository";
import { DeployProjectUseCase } from "../application/deploy-project.use-case";
import { ResourcePreflightService } from "../infrastructure/resource-preflight.service";
import { WorkerLock } from "../infrastructure/worker-lock";
import { DeployQueueService } from "../infrastructure/deploy-queue.service";

/**
 * Testes da FILA GLOBAL de deploy.
 *
 * O que precisa ser garantido (Wave 2):
 * - UM build por vez na VPS inteira (dois projetos não buildam junto);
 * - o mesmo commit do mesmo projeto não vira dois jobs;
 * - um job enfileirado SOBREVIVE a um restart da API;
 * - um job "running" quando a API morre vira "interrupted";
 * - em shutdown, nenhum job novo começa.
 */
class InMemoryDeployJobRepository implements DeployJobRepository {
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

  async findNextQueued(excludeIds: string[] = []): Promise<DeployJob | null> {
    return (
      [...this.jobs.values()]
        .filter((job) => job.status === "queued" && !excludeIds.includes(job.id))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null
    );
  }

  async findOpenByProject(projectId: string): Promise<DeployJob | null> {
    return (
      [...this.jobs.values()]
        .filter((job) => job.projectId === projectId && (job.status === "queued" || job.status === "running"))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null
    );
  }

  async findByProjectAndCommit(projectId: string, commitSha: string): Promise<DeployJob | null> {
    return (
      [...this.jobs.values()].find((job) => job.projectId === projectId && job.commitSha === commitSha) ?? null
    );
  }

  async findAllByStatus(status: DeployJobStatus): Promise<DeployJob[]> {
    return [...this.jobs.values()].filter((job) => job.status === status);
  }

  async findLatestByProject(projectId: string): Promise<DeployJob | null> {
    return [...this.jobs.values()].filter((job) => job.projectId === projectId).pop() ?? null;
  }

  async findRecent(limit: number): Promise<DeployJob[]> {
    return [...this.jobs.values()].slice(-limit);
  }

  async countByStatus(status: DeployJobStatus): Promise<number> {
    return [...this.jobs.values()].filter((job) => job.status === status).length;
  }
}

class FakePreflight {
  ok = true;
  reason: string | null = null;
  async check(): Promise<{ ok: boolean; reason: string | null; metrics: Record<string, unknown> }> {
    return { ok: this.ok, reason: this.reason, metrics: {} };
  }
}

class FakeDeployProject {
  readonly executed: string[] = [];
  private release: (() => void) | null = null;
  private started: Promise<void> | null = null;

  async executeJob(job: DeployJob): Promise<void> {
    this.executed.push(job.projectId);
    if (this.release) {
      await this.started;
    }
  }

  /**
   * Reserva de memória do projeto (usada pelo preflight da fila).
   * Sem este mock o serviço loga um warning em todo job.
   */
  async estimateMemoryReservation(): Promise<{
    productionLimitMb: number;
    stagingLimitMb: number;
    databaseBudgetTotalMb: number;
  }> {
    return { productionLimitMb: 0, stagingLimitMb: 0, databaseBudgetTotalMb: 0 };
  }

  /** Faz o deploy ficar pendente até o teste liberar. */
  block(): void {
    this.started = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  unblock(): void {
    this.release?.();
  }
}

class FakeProjectRepository {
  projects: any[] = [];
  async findAll(): Promise<any[]> {
    return this.projects;
  }
  async findById(): Promise<any | null> {
    return null;
  }
  async findByCustomDomain(): Promise<any | null> {
    return null;
  }
  async findByRepoUrl(): Promise<any[]> {
    return [];
  }
  async save(project: any): Promise<any> {
    return project;
  }
  async delete(): Promise<void> {}
}

describe("DeployQueueService (fila global)", () => {
  let lockDir: string;
  let previousLockDir: string | undefined;

  beforeEach(() => {
    lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-lock-"));
    previousLockDir = process.env.KORRELO_LOCK_DIR;
    process.env.KORRELO_LOCK_DIR = lockDir;
  });

  afterEach(() => {
    if (previousLockDir === undefined) delete process.env.KORRELO_LOCK_DIR;
    else process.env.KORRELO_LOCK_DIR = previousLockDir;
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  function buildQueue(repo: InMemoryDeployJobRepository, preflight: FakePreflight, deploy: FakeDeployProject) {
    return new DeployQueueService(
      repo,
      new FakeProjectRepository() as unknown as ProjectRepository,
      new WorkerLock(),
      preflight as unknown as ResourcePreflightService,
      deploy as unknown as DeployProjectUseCase,
    );
  }

  it("dois projetos pedindo deploy ao mesmo tempo: só UM build começa", async () => {
    const repo = new InMemoryDeployJobRepository();
    const preflight = new FakePreflight();
    const deploy = new FakeDeployProject();
    deploy.block();
    const queue = buildQueue(repo, preflight, deploy);

    await queue.enqueue({ projectId: "proj-a", commitSha: "sha-a", branch: "main", trigger: "webhook" });
    await queue.enqueue({ projectId: "proj-b", commitSha: "sha-b", branch: "main", trigger: "webhook" });

    // Primeiro job começa (e fica pendurado, de propósito).
    const first = queue.processNextJob();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deploy.executed).toEqual(["proj-a"]);

    // Enquanto o primeiro roda, o segundo NÃO começa (concorrência = 1).
    await queue.processNextJob();
    expect(deploy.executed).toEqual(["proj-a"]);

    // Liberando o primeiro, o segundo assume a fila.
    deploy.unblock();
    await first;
    await queue.processNextJob();
    expect(deploy.executed).toEqual(["proj-a", "proj-b"]);
  });

  it("o mesmo commit recebido duas vezes vira UM job só", async () => {
    const repo = new InMemoryDeployJobRepository();
    const queue = buildQueue(repo, new FakePreflight(), new FakeDeployProject());

    const first = await queue.enqueue({
      projectId: "proj-a",
      commitSha: "sha-1",
      branch: "main",
      trigger: "webhook",
    });
    const second = await queue.enqueue({
      projectId: "proj-a",
      commitSha: "sha-1",
      branch: "main",
      trigger: "webhook",
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(repo.jobs.size).toBe(1);
  });

  it("pushes seguidos se COALESCEM: o job na fila do commit antigo é cancelado", async () => {
    const repo = new InMemoryDeployJobRepository();
    const queue = buildQueue(repo, new FakePreflight(), new FakeDeployProject());

    const oldJob = await queue.enqueue({
      projectId: "proj-a",
      commitSha: "sha-1",
      branch: "main",
      trigger: "webhook",
    });
    const newJob = await queue.enqueue({
      projectId: "proj-a",
      commitSha: "sha-2",
      branch: "main",
      trigger: "webhook",
    });

    expect(newJob.job.id).not.toBe(oldJob.job.id);
    expect((await repo.findById(oldJob.job.id))?.status).toBe("canceled");
    expect((await repo.findById(newJob.job.id))?.status).toBe("queued");
  });

  it("um job QUEUED sobrevive a um restart da API", async () => {
    const repo = new InMemoryDeployJobRepository();
    const firstQueue = buildQueue(repo, new FakePreflight(), new FakeDeployProject());
    const { job } = await firstQueue.enqueue({
      projectId: "proj-a",
      commitSha: "sha-1",
      branch: "main",
      trigger: "webhook",
    });

    // "Restart": uma nova instância da API com o MESMO repositório.
    const secondQueue = buildQueue(repo, new FakePreflight(), new FakeDeployProject());
    await secondQueue.recoverInterruptedJobs();

    const reloaded = await repo.findById(job.id);
    expect(reloaded?.status).toBe("queued");
  });

  it("um job RUNNING vira INTERRUPTED quando a API morre no meio do deploy", async () => {
    const repo = new InMemoryDeployJobRepository();
    const queue = buildQueue(repo, new FakePreflight(), new FakeDeployProject());
    const { job } = await queue.enqueue({
      projectId: "proj-a",
      commitSha: "sha-1",
      branch: "main",
      trigger: "webhook",
    });
    await repo.save(job.withStatus("running").withStartedAt(new Date()));

    const restarted = buildQueue(repo, new FakePreflight(), new FakeDeployProject());
    await restarted.recoverInterruptedJobs();

    const recovered = await repo.findById(job.id);
    expect(recovered?.status).toBe("interrupted");
    expect(recovered?.errorMessage).toContain("interrompido");
  });

  it("um job interrompido pode ser reativado (retry controlado)", async () => {
    const repo = new InMemoryDeployJobRepository();
    const queue = buildQueue(repo, new FakePreflight(), new FakeDeployProject());
    const { job } = await queue.enqueue({
      projectId: "proj-a",
      commitSha: "sha-1",
      branch: "main",
      trigger: "webhook",
    });
    await repo.save(job.withStatus("interrupted").withError("morreu"));

    const retried = await queue.retry(job.id);
    expect(retried?.created).toBe(true);
    expect((await repo.findById(job.id))?.status).toBe("queued");
    expect((await repo.findById(job.id))?.attempt).toBe(1);
  });

  it("shutdown gracioso: nenhum job novo começa", async () => {
    const repo = new InMemoryDeployJobRepository();
    const deploy = new FakeDeployProject();
    const queue = buildQueue(repo, new FakePreflight(), deploy);

    queue.onApplicationShutdown();

    await queue.enqueue({ projectId: "proj-a", commitSha: "sha-1", branch: "main", trigger: "webhook" });
    await queue.processNextJob();

    expect(deploy.executed).toEqual([]);
    const stats = await queue.getStats();
    expect(stats.draining).toBe(true);
    expect(stats.queued).toBe(1);
  });

  it("sem recursos suficientes o job volta pra fila (e não quebra a produção)", async () => {
    const repo = new InMemoryDeployJobRepository();
    const preflight = new FakePreflight();
    preflight.ok = false;
    preflight.reason = "memória livre insuficiente";
    const deploy = new FakeDeployProject();
    const queue = buildQueue(repo, preflight, deploy);

    const { job } = await queue.enqueue({
      projectId: "proj-a",
      commitSha: "sha-1",
      branch: "main",
      trigger: "webhook",
    });
    await queue.processNextJob();

    expect(deploy.executed).toEqual([]);
    const reloaded = await repo.findById(job.id);
    expect(reloaded?.status).toBe("queued");
    expect(reloaded?.stage).toBe("waiting-resources");
  });

  it("startup NÃO dispara deploy: jobs enfileirados antes do processo ficam pausados", async () => {
    const repo = new InMemoryDeployJobRepository();
    const deploy = new FakeDeployProject();

    // Job criado ANTES deste processo subir (ex.: enfileirado por uma versão
    // anterior do Korrelo).
    const oldJob = new DeployJob(
      "job-antigo",
      "proj-a",
      "sha-antigo",
      "main",
      "webhook",
      "queued",
      0,
      "queued",
      null,
      "",
      null,
      null,
      false,
      false,
      null,
      null,
      null,
      new Date(Date.now() - 60_000),
      null,
      null,
    );
    await repo.save(oldJob);

    const queue = buildQueue(repo, new FakePreflight(), deploy);
    await queue.pausePreExistingJobs();

    // O worker não pega o job pausado.
    await queue.processNextJob();
    expect(deploy.executed).toEqual([]);
    expect(queue.listPausedJobIds()).toContain("job-antigo");

    // Só um "resume" explícito libera.
    await queue.resume("job-antigo");
    await queue.processNextJob();
    expect(deploy.executed).toEqual(["proj-a"]);
  });

  it("job criado DEPOIS do startup não é pausado (push novo roda normalmente)", async () => {
    const repo = new InMemoryDeployJobRepository();
    const deploy = new FakeDeployProject();
    const queue = buildQueue(repo, new FakePreflight(), deploy);

    await queue.enqueue({ projectId: "proj-a", commitSha: "sha-1", branch: "main", trigger: "webhook" });
    await queue.pausePreExistingJobs();
    await queue.processNextJob();

    expect(deploy.executed).toEqual(["proj-a"]);
  });

  it("em DRAIN (atualização do Korrelo) nenhum job começa", async () => {
    const repo = new InMemoryDeployJobRepository();
    const deploy = new FakeDeployProject();
    const queue = buildQueue(repo, new FakePreflight(), deploy);

    const { job } = await queue.enqueue({
      projectId: "proj-a",
      commitSha: "sha-1",
      branch: "main",
      trigger: "webhook",
    });
    await queue.drain("atualização do Korrelo");
    expect(queue.isDraining()).toBe(true);

    await queue.processNextJob();
    expect(deploy.executed).toEqual([]);
    // O push NÃO foi perdido: o job continua enfileirado (aguardando).
    expect((await repo.findById(job.id))?.status).toBe("queued");

    // Ao liberar, o job roda normalmente.
    await queue.releaseDrain();
    expect(queue.isDraining()).toBe(false);
    await queue.processNextJob();
    expect(deploy.executed).toEqual(["proj-a"]);
  });

  it("o drain expira sozinho (não trava os deploys para sempre)", async () => {
    const repo = new InMemoryDeployJobRepository();
    const deploy = new FakeDeployProject();
    const queue = buildQueue(repo, new FakePreflight(), deploy);

    // Arquivo de drain já vencido (simula um update que morreu no meio).
    const drainFile = path.join(lockDir, "worker-drain");
    fs.writeFileSync(drainFile, JSON.stringify({ at: new Date().toISOString(), expiresAt: Date.now() - 1000 }));

    process.env.KORRELO_DRAIN_FILE = drainFile;
    try {
      expect(queue.isDraining()).toBe(false);
      await queue.enqueue({ projectId: "proj-a", commitSha: "sha-1", branch: "main", trigger: "webhook" });
      await queue.processNextJob();
      expect(deploy.executed).toEqual(["proj-a"]);
    } finally {
      delete process.env.KORRELO_DRAIN_FILE;
    }
  });
});
