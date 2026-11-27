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
  metrics: Record<string, unknown> = {};
  async check(): Promise<{ ok: boolean; reason: string | null; metrics: Record<string, unknown> }> {
    return { ok: this.ok, reason: this.reason, metrics: this.metrics };
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
  async findById(projectId: string): Promise<any | null> {
    return this.projects.find((project) => project.id === projectId) ?? null;
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

  function buildQueue(
    repo: InMemoryDeployJobRepository,
    preflight: FakePreflight,
    deploy: FakeDeployProject,
    projectRepo: FakeProjectRepository = new FakeProjectRepository(),
  ) {
    return new DeployQueueService(
      repo,
      projectRepo as unknown as ProjectRepository,
      new WorkerLock(),
      preflight as unknown as ResourcePreflightService,
      deploy as unknown as DeployProjectUseCase,
    );
  }

  it("estado INDETERMINADO bloqueia deploy do MESMO projeto (não de outros)", async () => {
    const repo = new InMemoryDeployJobRepository();
    const preflight = new FakePreflight();
    const deploy = new FakeDeployProject();
    const projectRepo = new FakeProjectRepository();
    projectRepo.projects = [
      { id: "p-indeterminate", name: "Quebrado", lastDeployStatus: "indeterminate" },
      { id: "p-saudavel", name: "Saudável", lastDeployStatus: "succeeded" },
    ];
    const queue = buildQueue(repo, preflight, deploy, projectRepo);

    await expect(
      queue.enqueue({ projectId: "p-indeterminate", commitSha: "abc123", branch: "main", trigger: "manual" }),
    ).rejects.toThrow(/INDETERMINADO/);
    // Nenhum job criado para o projeto bloqueado.
    expect(await repo.findOpenByProject("p-indeterminate")).toBeNull();

    // Outro projeto continua podendo enfileirar.
    const other = await queue.enqueue({
      projectId: "p-saudavel",
      commitSha: "def456",
      branch: "main",
      trigger: "manual",
    });
    expect(other.created).toBe(true);
  });

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

  it("retry manual abre NOVA janela de recursos sem perder o histórico", async () => {
    const repo = new InMemoryDeployJobRepository();
    const preflight = new FakePreflight();
    const deploy = new FakeDeployProject();
    const queue = buildQueue(repo, preflight, deploy);
    (queue as unknown as { kick: () => void }).kick = () => undefined;

    const failed = new DeployJob(
      "job-retry-window",
      "proj-a",
      "sha-fixo",
      "main",
      "manual",
      "failed",
      5,
      "complete",
      "Recursos insuficientes",
      "",
      null,
      null,
      false,
      false,
      null,
      null,
      null,
      new Date(Date.now() - 60_000),
      new Date(Date.now() - 50_000),
      new Date(Date.now() - 40_000),
    );
    await repo.save(failed);

    let clock = Date.now();
    const spy = jest.spyOn(Date, "now").mockImplementation(() => clock);
    preflight.ok = false;
    preflight.reason = "sem memória";

    const retried = await queue.retry(failed.id);
    expect(retried?.created).toBe(true);
    expect(retried?.job.status).toBe("queued");
    expect(retried?.job.attempt).toBe(6);
    expect(retried?.job.commitSha).toBe("sha-fixo");

    // Primeira avaliação da nova janela NÃO pode falhar de imediato.
    await queue.processNextJob();
    let current = await repo.findById(failed.id);
    expect(current?.status).toBe("queued");
    expect(current?.stage).toBe("waiting-resources");

    // Consome o restante da janela (5 tentativas no total).
    for (let index = 1; index < 5; index += 1) {
      clock += 20 * 60_000;
      await queue.processNextJob();
      current = await repo.findById(failed.id);
      if (index < 4) expect(current?.status).toBe("queued");
    }
    expect(current?.status).toBe("failed");
    expect(current?.errorMessage).toContain("Recursos insuficientes");
    expect(current?.commitSha).toBe("sha-fixo");
    expect(current?.attempt).toBeGreaterThanOrEqual(6);

    spy.mockRestore();
  });

  it("retry concorrente não duplica requeue nem perde o commit", async () => {
    const repo = new InMemoryDeployJobRepository();
    const queue = buildQueue(repo, new FakePreflight(), new FakeDeployProject());
    (queue as unknown as { kick: () => void }).kick = () => undefined;
    const failed = new DeployJob(
      "job-retry-race",
      "proj-a",
      "sha-race",
      "main",
      "manual",
      "failed",
      5,
      "complete",
      "Recursos insuficientes",
      "",
      null,
      null,
      false,
      false,
      null,
      null,
      null,
      new Date(),
      new Date(),
      new Date(),
    );
    await repo.save(failed);

    const results = await Promise.all([queue.retry(failed.id), queue.retry(failed.id)]);

    expect(results.filter((result) => result?.created === true)).toHaveLength(1);
    const current = await repo.findById(failed.id);
    expect(current?.status).toBe("queued");
    expect(current?.attempt).toBe(6);
    expect(current?.commitSha).toBe("sha-race");
  });

  it("restart do worker inicia nova janela de recursos para job antigo", async () => {
    const repo = new InMemoryDeployJobRepository();
    const failed = new DeployJob(
      "job-restart-window",
      "proj-a",
      "sha-restart",
      "main",
      "manual",
      "failed",
      5,
      "complete",
      "Recursos insuficientes",
      "",
      null,
      null,
      false,
      false,
      null,
      null,
      null,
      new Date(),
      new Date(),
      new Date(),
    );
    await repo.save(failed);

    const preflight = new FakePreflight();
    preflight.ok = false;
    preflight.reason = "sem memória";
    const queue = buildQueue(repo, preflight, new FakeDeployProject());
    (queue as unknown as { kick: () => void }).kick = () => undefined;

    const retried = await queue.retry(failed.id);
    expect(retried?.created).toBe(true);
    await queue.processNextJob();

    const current = await repo.findById(failed.id);
    expect(current?.status).toBe("queued");
    expect(current?.stage).toBe("waiting-resources");
    expect(current?.commitSha).toBe("sha-restart");
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

  it("deploy MANUAL explicito substitui o job pausado no startup (não fica preso)", async () => {
    const repo = new InMemoryDeployJobRepository();
    const deploy = new FakeDeployProject();

    const oldJob = new DeployJob(
      "job-pausado",
      "proj-a",
      "sha-antigo",
      "main",
      "webhook",
      "queued",
      0,
      "queued",
      "Pausado: o job foi enfileirado antes da última atualização do Korrelo.",
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
    expect(queue.listPausedJobIds()).toContain("job-pausado");

    const result = await queue.enqueue({
      projectId: "proj-a",
      commitSha: null,
      branch: "main",
      trigger: "manual",
    });

    // O clique manual é uma ação explícita do operador: não pode ser engolido
    // pelo job antigo pausado.
    expect(result.created).toBe(true);
    expect(result.job.id).not.toBe("job-pausado");
    expect(queue.listPausedJobIds()).not.toContain("job-pausado");
    const old = await repo.findById("job-pausado");
    expect(old?.status).toBe("canceled");

    // E o job novo realmente chega ao executor.
    await queue.processNextJob();
    expect(deploy.executed).toEqual(["proj-a"]);
  });

  it("job RUNNING nunca é cancelado nem substituído por deploy manual", async () => {
    const repo = new InMemoryDeployJobRepository();
    const deploy = new FakeDeployProject();
    const running = new DeployJob(
      "job-running",
      "proj-a",
      "sha-1",
      "main",
      "webhook",
      "running",
      1,
      "promote",
      null,
      "",
      null,
      null,
      false,
      false,
      null,
      null,
      null,
      new Date(Date.now() - 5_000),
      new Date(),
      null,
    );
    await repo.save(running);
    const queue = buildQueue(repo, new FakePreflight(), deploy);

    const result = await queue.enqueue({
      projectId: "proj-a",
      commitSha: null,
      branch: "main",
      trigger: "manual",
    });

    expect(result.created).toBe(false);
    expect(result.job.id).toBe("job-running");
    expect((await repo.findById("job-running"))?.status).toBe("running");
    expect((await repo.findAllByStatus("running")).length).toBe(1);
  });

  it("dois cliques manuais SIMULTÂNEOS não criam dois jobs", async () => {
    const repo = new InMemoryDeployJobRepository();
    const deploy = new FakeDeployProject();
    const queue = buildQueue(repo, new FakePreflight(), deploy);

    const [a, b] = await Promise.all([
      queue.enqueue({ projectId: "proj-a", commitSha: null, branch: "main", trigger: "manual" }),
      queue.enqueue({ projectId: "proj-a", commitSha: null, branch: "main", trigger: "manual" }),
    ]);

    const jobs = [...repo.jobs.values()].filter((job) => job.projectId === "proj-a");
    expect(jobs).toHaveLength(1);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(a.job.id).toBe(b.job.id);
  });

  it("job manual novo resolve o commit na execução (commitSha nulo no agendamento)", async () => {
    const repo = new InMemoryDeployJobRepository();
    const deploy = new FakeDeployProject();
    const queue = buildQueue(repo, new FakePreflight(), deploy);

    const result = await queue.enqueue({
      projectId: "proj-a",
      commitSha: null,
      branch: "main",
      trigger: "manual",
    });

    expect(result.created).toBe(true);
    expect(result.job.commitSha).toBeNull();
    expect(result.job.branch).toBe("main");
    expect(result.job.trigger).toBe("manual");
  });

  it("um SEGUNDO restart mantém o webhook antigo pausado (nada roda sozinho)", async () => {
    const repo = new InMemoryDeployJobRepository();
    const deploy = new FakeDeployProject();
    const oldJob = new DeployJob(
      "job-webhook-antigo",
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
      new Date(Date.now() - 120_000),
      null,
      null,
    );
    await repo.save(oldJob);

    const primeiroBoot = buildQueue(repo, new FakePreflight(), deploy);
    await primeiroBoot.pausePreExistingJobs();
    await primeiroBoot.processNextJob();

    // Simula um segundo restart: outra instância, mesmo banco.
    const segundoBoot = buildQueue(repo, new FakePreflight(), deploy);
    await segundoBoot.pausePreExistingJobs();
    await segundoBoot.processNextJob();

    expect(deploy.executed).toEqual([]);
    expect(segundoBoot.listPausedJobIds()).toContain("job-webhook-antigo");
    expect((await repo.findById("job-webhook-antigo"))?.status).toBe("queued");
  });

  it("falha ao cancelar o job pausado NÃO cria job novo nem deixa o antigo solto", async () => {
    class SaveFailingRepository extends InMemoryDeployJobRepository {
      failCanceledSave = true;
      override async save(job: DeployJob): Promise<DeployJob> {
        if (this.failCanceledSave && job.status === "canceled") {
          this.failCanceledSave = false;
          throw new Error("sqlite indisponível");
        }
        return super.save(job);
      }
    }

    const repo = new SaveFailingRepository();
    const deploy = new FakeDeployProject();
    const oldJob = new DeployJob(
      "job-pausado",
      "proj-a",
      "sha-antigo",
      "main",
      "webhook",
      "queued",
      0,
      "queued",
      "Pausado no startup.",
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

    await expect(
      queue.enqueue({ projectId: "proj-a", commitSha: null, branch: "main", trigger: "manual" }),
    ).rejects.toThrow(/sqlite indisponível/);

    // O job antigo continua QUEUED e PAUSADO; nenhum job novo foi criado.
    expect([...repo.jobs.values()].filter((job) => job.projectId === "proj-a")).toHaveLength(1);
    expect((await repo.findById("job-pausado"))?.status).toBe("queued");
    expect(queue.listPausedJobIds()).toContain("job-pausado");

    await queue.processNextJob();
    expect(deploy.executed).toEqual([]);
  });

  it("job em espera de recursos NÃO bloqueia outro projeto (fairness)", async () => {
    const repo = new InMemoryDeployJobRepository();
    const preflight = new FakePreflight();
    const deploy = new FakeDeployProject();

    const mk = (id: string, projectId: string, offsetMs: number) =>
      new DeployJob(
        id,
        projectId,
        null,
        "main",
        "manual",
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
        new Date(Date.now() - offsetMs),
        null,
        null,
      );
    await repo.save(mk("job-a", "proj-a", 5_000));
    await repo.save(mk("job-b", "proj-b", 1_000));

    const queue = buildQueue(repo, preflight, deploy);

    preflight.ok = false;
    preflight.reason = "sem memória";
    await queue.processNextJob(); // job-a entra em backoff de recursos
    expect((await repo.findById("job-a"))?.stage).toBe("waiting-resources");
    expect(deploy.executed).toEqual([]);

    preflight.ok = true;
    preflight.reason = null;
    await queue.processNextJob(); // job-b não pode ficar atrás do job-a

    expect(deploy.executed).toEqual(["proj-b"]);
  });

  it("cancelar só vale para job na fila; running é recusado", async () => {
    const repo = new InMemoryDeployJobRepository();
    const deploy = new FakeDeployProject();
    const queued = new DeployJob(
      "job-queued",
      "proj-a",
      null,
      "main",
      "manual",
      "queued",
      0,
      "waiting-resources",
      "Recursos insuficientes",
      "",
      null,
      null,
      false,
      false,
      null,
      null,
      null,
      new Date(Date.now() - 1_000),
      null,
      null,
    );
    const running = new DeployJob(
      "job-running",
      "proj-b",
      "sha-1",
      "main",
      "manual",
      "running",
      1,
      "building",
      null,
      "",
      null,
      null,
      false,
      false,
      null,
      null,
      null,
      new Date(Date.now() - 2_000),
      new Date(),
      null,
    );
    await repo.save(queued);
    await repo.save(running);
    const queue = buildQueue(repo, new FakePreflight(), deploy);

    const canceled = await queue.cancel("job-queued");
    expect(canceled.ok).toBe(true);
    expect((await repo.findById("job-queued"))?.status).toBe("canceled");

    await queue.processNextJob();
    expect(deploy.executed).toEqual([]);

    const refused = await queue.cancel("job-running");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("not_queued");
    expect((await repo.findById("job-running"))?.status).toBe("running");

    const missing = await queue.cancel("job-inexistente");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("not_found");
  });

  it("describeJob informa espera, próximo teste e tentativas; pausa aparece", async () => {
    const repo = new InMemoryDeployJobRepository();
    const preflight = new FakePreflight();
    const deploy = new FakeDeployProject();
    const job = new DeployJob(
      "job-wait",
      "proj-a",
      null,
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
      new Date(Date.now() - 1_000),
      null,
      null,
    );
    await repo.save(job);
    const queue = buildQueue(repo, preflight, deploy);

    preflight.ok = false;
    preflight.reason = "sem memória";
    preflight.metrics = {
      freeMemMb: 2370,
      requiredHostMemoryMb: 2395,
      productionLimitMb: 1757,
      productionUsageMb: 386,
      memoryPolicyShadow: {
        basis: "observed-peak",
        requiredMb: 2048,
        savedMb: 347,
        confidence: "high",
      },
    };
    await queue.processNextJob();

    const waiting = queue.describeJob(await repo.findById("job-wait") as DeployJob);
    expect(waiting.waitingForResources).toBe(true);
    expect(waiting.paused).toBe(false);
    expect(waiting.maxResourceAttempts).toBeGreaterThan(0);
    expect(waiting.nextAttemptAt).not.toBeNull();
    expect(waiting.resourceCheck).toMatchObject({
      availableMemoryMb: 2370,
      requiredMemoryMb: 2395,
      productionLimitMb: 1757,
      productionUsageMb: 386,
      shadow: { basis: "observed-peak", requiredMb: 2048, savedMb: 347 },
    });

    const pausedQueue = buildQueue(repo, preflight, new FakeDeployProject());
    await pausedQueue.pausePreExistingJobs();
    const paused = pausedQueue.describeJob(await repo.findById("job-wait") as DeployJob);
    expect(paused.paused).toBe(true);
  });

  it("job aguardando recursos é retomado sozinho quando o host fica seguro", async () => {
    const repo = new InMemoryDeployJobRepository();
    const preflight = new FakePreflight();
    const deploy = new FakeDeployProject();
    const job = new DeployJob(
      "job-espera",
      "proj-a",
      null,
      "main",
      "manual",
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
      new Date(Date.now() - 1_000),
      null,
      null,
    );
    await repo.save(job);
    const queue = buildQueue(repo, preflight, deploy);

    const base = Date.now();
    const spy = jest.spyOn(Date, "now").mockReturnValue(base);

    preflight.ok = false;
    preflight.reason = "sem memória";
    await queue.processNextJob();
    expect(deploy.executed).toEqual([]);
    expect((await repo.findById("job-espera"))?.stage).toBe("waiting-resources");

    // Host fica seguro, mas ainda dentro do backoff: NÃO inicia.
    preflight.ok = true;
    preflight.reason = null;
    await queue.processNextJob();
    expect(deploy.executed).toEqual([]);

    // Passou o backoff: o próximo tick retoma sozinho.
    spy.mockReturnValue(base + 61_000);
    await queue.processNextJob();
    spy.mockRestore();

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
