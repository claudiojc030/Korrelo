import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Project } from "../domain/project.entity";
import type { DeployJob } from "../domain/deploy-job.entity";

/**
 * Testes do runner de deploy (Wave 2).
 *
 * Foco:
 * - o container de teste é SEMPRE removido (sucesso e falha);
 * - a versão anterior volta a ficar no ar quando a nova quebra na produção
 *   (rollback) - e o estado crítico fica registrado quando o rollback
 *   também falha;
 * - deploy falho NÃO derruba o estado de runtime da aplicação (cron, backup
 *   e terminal continuam funcionando);
 * - o commit implantado é exatamente o do job.
 */
class FakeProjectRepository {
  project: Project | null = null;
  saved: Project[] = [];
  async findAll(): Promise<Project[]> {
    return this.project ? [this.project] : [];
  }
  async findById(): Promise<Project | null> {
    return this.project;
  }
  async findByCustomDomain(): Promise<Project | null> {
    return null;
  }
  async findByRepoUrl(): Promise<Project[]> {
    return this.project ? [this.project] : [];
  }
  async save(project: Project): Promise<Project> {
    this.project = project;
    this.saved.push(project);
    return project;
  }
  async delete(): Promise<void> {
    this.project = null;
  }
}

class FakeOrchestrator {
  stagingCalls = 0;
  promoteCalls = 0;
  rollbackCalls: { previousImage: string }[] = [];
  removeStagingCalls = 0;
  pruneCalls: { protectedImages: string[] }[] = [];
  failStaging = false;
  failPromote = false;
  failRollback = false;
  /** Config recebida em deployStaging (para checar env do staging). */
  lastConfig: any = null;
  /** Quantas vezes a limpeza de cache de build foi chamada. */
  buildPruneCalls = 0;
  failBuildPrune = false;
  buildPruneResult: any = {
    imagePrune: { ok: true, output: null, error: null },
    builderPrune: { ok: true, output: null, error: null },
    reservedSpace: "2GB",
  };

  async deployStaging(config?: any): Promise<string> {
    this.lastConfig = config ?? null;
    this.stagingCalls += 1;
    if (this.failStaging) throw new Error("falha no staging");
    return "staging ok";
  }
  async pruneUnusedBuildArtifacts(): Promise<any> {
    this.buildPruneCalls += 1;
    if (this.failBuildPrune) throw new Error("docker indisponível");
    return this.buildPruneResult;
  }
  async promote(): Promise<string> {
    this.promoteCalls += 1;
    if (this.failPromote) throw new Error("falha no promote");
    return "promote ok";
  }
  async rollback(_config: unknown, previousImage: string): Promise<string> {
    this.rollbackCalls.push({ previousImage });
    if (this.failRollback) throw new Error("falha no rollback");
    return "rollback ok";
  }
  async removeStaging(): Promise<void> {
    this.removeStagingCalls += 1;
  }
  async teardown(): Promise<void> {}
  async supportsBuildKit(): Promise<boolean> {
    return false;
  }
  async pruneProjectImages(config: { protectedImages: string[] }): Promise<string> {
    this.pruneCalls.push(config);
    return "";
  }
}

class FakeHealthChecker {
  results: boolean[] = [];
  /** Timeout (ms) de cada chamada, na ordem em que foram feitas. */
  timeouts: number[] = [];
  /** Porta de cada chamada, na ordem em que foram feitas. */
  ports: number[] = [];
  async waitUntilHealthy(port?: number, timeoutMs?: number): Promise<boolean> {
    this.ports.push(port as number);
    this.timeouts.push(timeoutMs as number);
    return this.results.length > 0 ? (this.results.shift() as boolean) : true;
  }
}

/** Coletor de diagnóstico do staging (não chama Docker nos testes). */
class FakeStagingDiagnostics {
  calls: string[] = [];
  fail = false;
  capture: any = {
    containerName: "staging",
    state: {
      containerName: "staging",
      status: "exited",
      exitCode: 137,
      oomKilled: true,
      restartCount: 0,
      startedAt: "2026-10-22T18:00:00Z",
      finishedAt: "2026-10-22T18:00:05Z",
      memoryLimitMb: 600,
    },
    logs: "FATAL ERROR: Reached heap limit",
    errors: [],
  };
  async collect(containerName: string): Promise<any> {
    this.calls.push(containerName);
    if (this.fail) throw new Error("diagnóstico indisponível");
    return this.capture;
  }
}

class FakeDeployRecordRepository {
  records: any[] = [];
  async findByProjectId(): Promise<any[]> {
    return [];
  }
  async save(record: any): Promise<any> {
    this.records.push(record);
    return record;
  }
  async failAllRunning(): Promise<number> {
    return 0;
  }
}

class FakeDeployJobRepository {
  jobs = new Map<string, DeployJob>();
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
  async findAllByStatus(status?: string): Promise<DeployJob[]> {
    return [...this.jobs.values()].filter((job) => !status || job.status === status);
  }
  async findLatestByProject(): Promise<DeployJob | null> {
    return null;
  }
  async findRecent(): Promise<DeployJob[]> {
    return [];
  }
  async countByStatus(): Promise<number> {
    return 0;
  }
}

class FakeCloner {
  lastParams: { branch?: string | null; commitSha?: string | null } | null = null;
  async cloneOrUpdate(): Promise<void> {}
  async getCurrentBranch(): Promise<string | null> {
    return "main";
  }
  async getLastCommit(): Promise<{ hash: string; message: string } | null> {
    return { hash: "abc1234", message: "msg" };
  }
  async prepareCommit(
    _repoUrl: string,
    destPath: string,
    _token: string | undefined,
    params: { branch?: string | null; commitSha?: string | null },
  ): Promise<{ sha: string; message: string }> {
    fs.mkdirSync(destPath, { recursive: true });
    this.lastParams = params;
    return { sha: params.commitSha ?? "aaaaaaabbbbb", message: "msg" };
  }
}

class EmptyRepository {
  async findAll(): Promise<any[]> {
    return [];
  }
  async findAllByProjectId(): Promise<any[]> {
    return [];
  }
  async findByProjectId(): Promise<any[]> {
    return [];
  }
  async findById(): Promise<any | null> {
    return null;
  }
  async findLatest(): Promise<any | null> {
    return null;
  }
  async save(entity: any): Promise<any> {
    return entity;
  }
  async replaceAll(): Promise<any[]> {
    return [];
  }
  async upsertOne(): Promise<void> {}
}

/** Repositório de env vars controlável por teste (default: vazio). */
class FakeEnvVarRepository {
  vars: { id: string; projectId: string; key: string; value: string; createdAt: Date }[] = [];
  async findByProjectId(projectId: string): Promise<any[]> {
    return this.vars.filter((v) => v.projectId === projectId);
  }
  async findAll(): Promise<any[]> {
    return this.vars;
  }
  async save(entity: any): Promise<any> {
    return entity;
  }
}

describe("DeployProjectUseCase (Wave 2)", () => {
  let tempWorkspaceDir: string;
  let useCase: any;
  let ProjectEntity: any;
  let DeployJobEntity: any;

  const projectRepository = new FakeProjectRepository();
  const orchestrator = new FakeOrchestrator();
  const healthChecker = new FakeHealthChecker();
  const deployRecordRepository = new FakeDeployRecordRepository();
  const deployJobRepository = new FakeDeployJobRepository();
  const cloner = new FakeCloner();
  const envVarRepository = new FakeEnvVarRepository();
  const stagingDiagnostics = new FakeStagingDiagnostics();
  const deployLock = { held: true, isHeldByMe(): boolean { return this.held; } };
  const selfUpdateState = { running: false, isRunning(): boolean { return this.running; } };
  /** Porta alocada seguinte (a de produção vem antes da do staging). */
  let nextPort = 3200;

  beforeAll(() => {
    tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-deploy-"));
    process.env.KORRELO_WORKSPACE_DIR = tempWorkspaceDir;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ProjectEntity = require("../domain/project.entity").Project;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    DeployJobEntity = require("../domain/deploy-job.entity").DeployJob;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DeployProjectUseCase } = require("../application/deploy-project.use-case");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DockerComposeFileBuilder } = require("../infrastructure/docker-compose-file-builder");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DeployLogger } = require("../infrastructure/deploy-logger");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ResourcePreflightService } = require("../infrastructure/resource-preflight.service");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { safeHostResourceProvider } = require("../../../infrastructure/host-resources");

    useCase = new DeployProjectUseCase(
      projectRepository,
      { supports: () => true, generate: () => ({ dockerfile: "FROM node:20-alpine\n", dockerignore: ".env.korrelo\n" }) },
      orchestrator,
      healthChecker,
      envVarRepository,
      new EmptyRepository(),
      deployRecordRepository,
      cloner,
      { createInstallationToken: async () => ({ token: "t", expiresAt: new Date() }) },
      { findLatest: async () => null },
      // Portas sequenciais: a de produção e a do staging são DIFERENTES
      // (o staging é o container de teste) - é o que permite provar qual
      // espera de health é a do staging.
      { allocate: async () => nextPort++ },
      new DockerComposeFileBuilder(),
      deployJobRepository,
      new DeployLogger(),
      // Preflight com métricas de host FIXAS: o deploy de teste não pode
      // depender do load/RAM da máquina que roda o Jest.
      new ResourcePreflightService(safeHostResourceProvider()),
      // Diagnóstico do staging: fake (nada de Docker nos testes).
      stagingDiagnostics,
      // Lock do worker e estado do self-update (fakes mutáveis).
      deployLock as any,
      selfUpdateState,
    );
  });

  afterAll(() => {
    fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    orchestrator.stagingCalls = 0;
    orchestrator.promoteCalls = 0;
    orchestrator.rollbackCalls = [];
    orchestrator.removeStagingCalls = 0;
    orchestrator.failStaging = false;
    orchestrator.failPromote = false;
    orchestrator.failRollback = false;
    healthChecker.results = [];
    deployJobRepository.jobs.clear();
    deployRecordRepository.records = [];
    stagingDiagnostics.calls = [];
    stagingDiagnostics.fail = false;
    envVarRepository.vars = [];
    orchestrator.lastConfig = null;
    orchestrator.buildPruneCalls = 0;
    orchestrator.failBuildPrune = false;
    orchestrator.buildPruneResult = {
      imagePrune: { ok: true, output: null, error: null },
      builderPrune: { ok: true, output: null, error: null },
      reservedSpace: "2GB",
    };
    deployLock.held = true;
    selfUpdateState.running = false;

    projectRepository.project = new ProjectEntity(
      "proj-1",
      "Meu Projeto",
      "https://github.com/exemplo/projeto.git",
      JSON.stringify({
        language: "Node.js",
        framework: "Express",
        packageManager: "npm",
        recommendedPort: 3000,
        startCommand: "npm run start",
        buildCommand: null,
        entryPoint: null,
      }),
      "configuring",
      null,
      null,
      true,
      true,
      null,
      "none",
      false,
      "main",
      null,
      false,
      null,
      null,
      "korrelo-x:commit-antiga",
      "korrelo-x:commit-anterior",
      null,
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
  });

  function makeJob(commitSha: string | null = "aaaaaaabbbbb"): any {
    const job = DeployJobEntity.create({
      projectId: "proj-1",
      commitSha,
      branch: "develop",
      trigger: "webhook",
    });
    deployJobRepository.jobs.set(job.id, job);
    return job;
  }

  it("implanta o commit exato do job (nunca outro)", async () => {
    const job = makeJob("abcdef1234567890");
    await useCase.executeJob(job);

    expect(cloner.lastParams).toEqual({ branch: "develop", commitSha: "abcdef1234567890" });
  });

  it("sucesso: remove o container de teste e registra a imagem em produção", async () => {
    const job = makeJob();
    await useCase.executeJob(job);

    expect(orchestrator.stagingCalls).toBe(1);
    expect(orchestrator.promoteCalls).toBe(1);
    expect(orchestrator.removeStagingCalls).toBe(1);
    expect(projectRepository.project?.status).toBe("running");
    expect(projectRepository.project?.lastDeployStatus).toBe("succeeded");
    // A imagem que estava em produção vira a "anterior" (é o alvo do
    // rollback); a nova imagem é a atual.
    expect(projectRepository.project?.previousImage).toBe("korrelo-x:commit-antiga");
    expect(projectRepository.project?.currentImage).toContain("commit-aaaaaaabbbbb");
  });

  it("falha no staging: produção intacta, runtime NÃO vira 'failed' e staging é removido", async () => {
    orchestrator.failStaging = true;
    const job = makeJob();

    await expect(useCase.executeJob(job)).rejects.toThrow("falha no staging");

    expect(orchestrator.promoteCalls).toBe(0);
    expect(orchestrator.removeStagingCalls).toBe(1);
    expect(projectRepository.project?.status).not.toBe("failed");
    expect(projectRepository.project?.lastDeployStatus).toBe("failed");
  });

  it("health do staging falha: captura estado/logs ANTES do cleanup (só do staging)", async () => {
    healthChecker.results = [false]; // staging não responde
    const job = makeJob();

    await expect(useCase.executeJob(job)).rejects.toThrow(/Container de teste subiu mas não respondeu/);

    // Capturou o diagnóstico do container de TESTE, nunca o de produção.
    expect(stagingDiagnostics.calls).toHaveLength(1);
    expect(stagingDiagnostics.calls[0]).toContain("-staging");
    expect(stagingDiagnostics.calls[0]).not.toBe("korrelo-x");

    const lastRecord = deployRecordRepository.records.at(-1);
    expect(lastRecord.log).toContain("diagnóstico do staging (antes do cleanup)");
    expect(lastRecord.log).toContain("oomKilled: true");
    expect(lastRecord.log).toContain("exitCode: 137");
    expect(lastRecord.log).toContain("FATAL ERROR: Reached heap limit");
    // O registro continua marcado como falha e o staging foi removido.
    expect(lastRecord.status).toBe("failed");
    expect(orchestrator.removeStagingCalls).toBe(1);
  });

  it("falha ao capturar diagnóstico NÃO substitui a causa original nem impede o cleanup", async () => {
    healthChecker.results = [false];
    stagingDiagnostics.fail = true;
    const job = makeJob();

    await expect(useCase.executeJob(job)).rejects.toThrow(/Container de teste subiu mas não respondeu/);
    expect(stagingDiagnostics.calls).toHaveLength(1);
    expect(orchestrator.removeStagingCalls).toBe(1);
    expect(projectRepository.project?.lastDeployStatus).toBe("failed");
  });

  it("deploy com sucesso não coleta diagnóstico (staging já foi removido antes)", async () => {
    healthChecker.results = [true, true];
    const job = makeJob();

    await useCase.executeJob(job);

    expect(stagingDiagnostics.calls).toEqual([]);
    expect(orchestrator.removeStagingCalls).toBe(1);
  });

  it("falha na promoção: faz ROLLBACK para a imagem anterior", async () => {
    healthChecker.results = [true, false]; // staging ok, produção não responde
    const job = makeJob();

    await expect(useCase.executeJob(job)).rejects.toThrow();

    expect(orchestrator.promoteCalls).toBe(1);
    expect(orchestrator.rollbackCalls).toHaveLength(1);
    expect(orchestrator.rollbackCalls[0].previousImage).toBe("korrelo-x:commit-antiga");
    // O rollback devolvendo o app no ar: o runtime continua "running".
    healthChecker.results = [true];
    expect(projectRepository.project?.status).not.toBe("failed");
  });

  it("rollback que também falha: estado crítico registrado e runtime marcado como quebrado", async () => {
    healthChecker.results = [true, false, false]; // staging ok, produção não, rollback também não
    orchestrator.failRollback = true;
    const job = makeJob();

    await expect(useCase.executeJob(job)).rejects.toThrow();

    const jobFinal = deployJobRepository.jobs.get(job.id);
    expect(jobFinal?.rollbackAttempted).toBe(true);
    expect(jobFinal?.rollbackSucceeded).toBe(false);
    // Aqui a produçãoreally ficou sem resposta: o runtime é marcado como falho.
    expect(projectRepository.project?.status).toBe("failed");
    expect(projectRepository.project?.lastDeployStatus).toBe("failed");
  });

  it("o arquivo de ambiente do projeto fica FORA do diretório do projeto", async () => {
    const job = makeJob();
    await useCase.executeJob(job);
    const projectDir = path.join(tempWorkspaceDir, "proj-1");
    expect(fs.existsSync(path.join(projectDir, ".env.korrelo"))).toBe(false);
    expect(fs.existsSync(path.join(tempWorkspaceDir, "proj-1-secrets", ".env.korrelo"))).toBe(true);
    // E o .dockerignore obrigatório existe (o segredo não entra no contexto).
    expect(fs.existsSync(path.join(projectDir, ".dockerignore"))).toBe(true);
  });

  it("projeto ADOTADO (grandfathered) mantém o limite de produção observado", async () => {
    // Mesatta-like: o container de produção tem 1757 MB; a fórmula nova daria
    // bem menos. O deploy NÃO pode reduzir.
    const current = projectRepository.project as any;
    projectRepository.project = current.withRuntimeObservation({
      productionMemoryLimitMb: 1757,
      runtimeSnapshot: null,
      grandfathered: true,
      grandfatheredAt: new Date(),
      runtimeDriftDetected: false,
      runtimeDriftDetails: null,
    });

    const job = makeJob();
    await useCase.executeJob(job);

    const compose = fs.readFileSync(
      path.join(tempWorkspaceDir, "proj-1", "docker-compose.korrelo.yml"),
      "utf-8",
    );
    // O limite de PRODUÇÃO é o observado (1757), não o calculado.
    expect(compose).toContain("mem_limit: 1757m");
    expect(compose).not.toContain("mem_limit: 486m");
  });

  it("staging por projeto: o limite configurado vale SÓ no container de TESTE", async () => {
    // Mesatta-like: produção observada em 1757 MB, staging pedido em 600 MB.
    const current = projectRepository.project as any;
    projectRepository.project = current
      .withRuntimeObservation({
        productionMemoryLimitMb: 1757,
        runtimeSnapshot: null,
        grandfathered: true,
        grandfatheredAt: new Date(),
        runtimeDriftDetected: false,
        runtimeDriftDetails: null,
      })
      .withStagingConfig({
        stagingMemoryLimitMb: 600,
        stagingHealthTimeoutSeconds: 120,
      });

    const job = makeJob();
    await useCase.executeJob(job);

    const compose = fs.readFileSync(
      path.join(tempWorkspaceDir, "proj-1", "docker-compose.korrelo.yml"),
      "utf-8",
    );
    // O container de TESTE recebeu os 600 MB pedidos.
    expect(compose).toContain("mem_limit: 600m");
    // A PRODUÇÃO continua em 1757 MB (não foi tocada).
    expect(compose).toContain("mem_limit: 1757m");
    // A produção do projeto segue com o limite observado.
    expect(projectRepository.project?.productionMemoryLimitMb).toBe(1757);
  });

  it("staging por projeto: o timeout customizado vale SÓ na espera do staging", async () => {
    const current = projectRepository.project as any;
    projectRepository.project = current
      .withRuntimeObservation({
        productionMemoryLimitMb: 1757,
        runtimeSnapshot: null,
        grandfathered: true,
        grandfatheredAt: new Date(),
        runtimeDriftDetected: false,
        runtimeDriftDetails: null,
      })
      .withStagingConfig({
        stagingMemoryLimitMb: 600,
        stagingHealthTimeoutSeconds: 120,
      });

    healthChecker.timeouts = [];
    healthChecker.ports = [];
    const job = makeJob();
    await useCase.executeJob(job);

    // A 1ª espera é a do STAGING e usa 120s (o override do projeto).
    // As portas são alocadas em ordem (produção primeiro, staging depois) e
    // as esperas de health acontecem na ordem staging -> produção: a 1ª
    // espera é, portanto, a do container de TESTE, numa porta diferente da
    // de produção.
    expect(healthChecker.ports[0]).not.toBe(healthChecker.ports[1]);
    expect(healthChecker.timeouts[0]).toBe(120_000);
    // A 2ª é a da PRODUÇÃO e continua com 30s (o override é SÓ do staging).
    expect(healthChecker.timeouts[1]).toBe(30_000);
  });

  it("staging por projeto: SEM override, o staging continua com 30s e o automático", async () => {
    healthChecker.timeouts = [];
    healthChecker.ports = [];
    const job = makeJob();
    await useCase.executeJob(job);

    // Sem override: o default de 30s vale para o staging.
    expect(healthChecker.timeouts[0]).toBe(30_000);
    expect(healthChecker.timeouts[1]).toBe(30_000);
  });

  // ---------------------------------------------------- staging-only / env
  function makeStagingJob(): any {
    const job = DeployJobEntity.create({
      projectId: "proj-1",
      commitSha: null,
      branch: "develop",
      trigger: "staging",
    });
    deployJobRepository.jobs.set(job.id, job);
    return job;
  }

  it("staging-only: valida, remove o container e NÃO promove nem altera imagens", async () => {
    const job = makeStagingJob();

    await useCase.executeJob(job);

    expect(orchestrator.stagingCalls).toBe(1);
    expect(orchestrator.promoteCalls).toBe(0);
    expect(orchestrator.removeStagingCalls).toBe(1);
    // Nenhuma imagem do projeto muda (nada foi promovido).
    expect(projectRepository.project?.currentImage).toBe("korrelo-x:commit-antiga");
    expect(projectRepository.project?.previousImage).toBe("korrelo-x:commit-anterior");
    expect(deployJobRepository.jobs.get(job.id)?.status).toBe("succeeded");
    expect(deployRecordRepository.records.at(-1)?.status).toBe("success");
  });

  it("staging-only com falha no health: cleanup acontece e nada é promovido", async () => {
    healthChecker.results = [false];
    const job = makeStagingJob();

    await expect(useCase.executeJob(job)).rejects.toThrow(/não respondeu/);

    expect(orchestrator.promoteCalls).toBe(0);
    expect(orchestrator.removeStagingCalls).toBe(1);
    expect(projectRepository.project?.currentImage).toBe("korrelo-x:commit-antiga");
    expect(projectRepository.project?.previousImage).toBe("korrelo-x:commit-anterior");
    expect(deployJobRepository.jobs.get(job.id)?.status).toBe("failed");
  });

  it("variável reservada KORRELO_DEPLOY_ENV: deploy é recusado antes do build", async () => {
    envVarRepository.vars = [
      { id: "e1", projectId: "proj-1", key: "KORRELO_DEPLOY_ENV", value: "production", createdAt: new Date() },
    ];

    await expect(useCase.executeJob(makeJob())).rejects.toThrow(/reservada/);
    // Falhou antes de qualquer build/staging.
    expect(orchestrator.stagingCalls).toBe(0);
  });

  it("env KORRELO_STAGING_* vai SÓ para o container de teste", async () => {
    envVarRepository.vars = [
      { id: "e1", projectId: "proj-1", key: "API_KEY", value: "prod-value", createdAt: new Date() },
      {
        id: "e2",
        projectId: "proj-1",
        key: "KORRELO_STAGING_EMAIL_POLLER",
        value: "0",
        createdAt: new Date(),
      },
    ];

    await useCase.executeJob(makeJob());

    const secretsDir = path.join(tempWorkspaceDir, "proj-1-secrets");
    const prodFile = fs.readFileSync(path.join(secretsDir, ".env.korrelo"), "utf-8");
    const stagingFile = fs.readFileSync(path.join(secretsDir, ".env.korrelo.staging"), "utf-8");

    // Produção: valor normal e NENHUMA variável de staging.
    expect(prodFile).toContain("API_KEY=prod-value");
    expect(prodFile).not.toContain("KORRELO_STAGING_");
    // Staging: prefixo removido, sem herdar o arquivo de produção.
    expect(stagingFile).toContain("EMAIL_POLLER=0");
    expect(stagingFile).not.toContain("API_KEY");

    expect(orchestrator.lastConfig?.envFilePath).toMatch(/\.env\.korrelo$/);
    expect(orchestrator.lastConfig?.stagingEnvFilePath).toMatch(/\.env\.korrelo\.staging$/);
  });

  it("sem envs de staging, o compose não recebe arquivo extra", async () => {
    await useCase.executeJob(makeJob());

    expect(orchestrator.lastConfig?.stagingEnvFilePath).toBeNull();
  });

  // ------------------------------------------ limpeza de cache de build (W1)
  it("deploy com sucesso limpa o cache de build (uma vez, no finally)", async () => {
    await useCase.executeJob(makeJob());

    expect(orchestrator.promoteCalls).toBe(1);
    expect(orchestrator.buildPruneCalls).toBe(1);
  });

  it("staging malsucedido TAMBÉM limpa o cache de build", async () => {
    orchestrator.failStaging = true;

    await expect(useCase.executeJob(makeJob())).rejects.toThrow("falha no staging");

    expect(orchestrator.promoteCalls).toBe(0);
    expect(orchestrator.buildPruneCalls).toBe(1);
  });

  it("falha na limpeza NÃO altera o resultado do deploy", async () => {
    orchestrator.failBuildPrune = true;
    const job = makeJob();

    await useCase.executeJob(job);

    expect(deployJobRepository.jobs.get(job.id)?.status).toBe("succeeded");
  });

  it("falha na limpeza não substitui o erro original do staging", async () => {
    orchestrator.failStaging = true;
    orchestrator.failBuildPrune = true;

    await expect(useCase.executeJob(makeJob())).rejects.toThrow("falha no staging");
  });

  it("limpeza recusada quando outro deploy está em andamento", async () => {
    const other = DeployJobEntity.create({
      projectId: "proj-2",
      commitSha: "ffffffffffff",
      branch: "main",
      trigger: "manual",
    });
    deployJobRepository.jobs.set(other.id, other.withStatus("running"));

    await useCase.executeJob(makeJob());

    expect(orchestrator.buildPruneCalls).toBe(0);
  });

  it("limpeza recusada durante self-update do Korrelo", async () => {
    selfUpdateState.running = true;

    await useCase.executeJob(makeJob());

    expect(orchestrator.buildPruneCalls).toBe(0);
  });

  it("limpeza recusada quando o lock do worker não é deste processo", async () => {
    deployLock.held = false;

    await useCase.executeJob(makeJob());

    expect(orchestrator.buildPruneCalls).toBe(0);
  });

  it("resultado parcial (builder prune falhou) não derruba o deploy", async () => {
    orchestrator.buildPruneResult = {
      imagePrune: { ok: true, output: null, error: null },
      builderPrune: { ok: false, output: null, error: "flag não suportada" },
      reservedSpace: "2GB",
    };

    await useCase.executeJob(makeJob());

    expect(orchestrator.buildPruneCalls).toBe(1);
    expect(projectRepository.project?.lastDeployStatus).toBe("succeeded");
  });
});
