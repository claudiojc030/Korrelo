import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEPLOY_JOB_REPOSITORY,
  type DeployJobRepository,
} from "../domain/deploy-job.repository";
import { DeployJob, type DeployJobTrigger } from "../domain/deploy-job.entity";
import { WorkerLock } from "./worker-lock";
import { ResourcePreflightService } from "./resource-preflight.service";
import { DeployProjectUseCase } from "../application/deploy-project.use-case";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";

/**
 * FILA GLOBAL DE DEPLOY (concorrência = 1 na VPS inteira).
 *
 * Por que: na auditoria de 19/10/2026 ficou claro que dois builds
 * simultâneos (um por projeto) numa VPS de 1 vCPU é o caminho mais curto
 * pra derrubar o host. A serialização que existia era POR PROJETO - dois
 * projetos diferentes buildavam ao mesmo tempo.
 *
 * Garantias:
 * - UM job roda por vez na VPS inteira (fila global + lock de arquivo entre
 *   processos);
 * - o estado vive no SQLite (tabela DeployJob): um restart da API NÃO
 *   perde jobs enfileirados;
 * - jobs "running" quando a API morre são marcados "interrupted" no boot
 *   (startup recovery) e podem ser retentados de forma controlada;
 * - o mesmo commit do mesmo projeto não vira dois jobs (dedupe por
 *   projectId+commitSha); um job manual por projeto em aberto (dedupe por
 *   projeto);
 * - pushes seguidos se COALESCEM: se o job anterior ainda está na fila (não
 *   começou), ele é cancelado e o commit novo assume. Job já iniciado NUNCA
 *   é cancelado - e nenhum commit é misturado: cada job tem UM commit.
 * - antes de começar, o preflight confere RAM/disco/Docker: sem folga, o job
 *   volta pra fila (com backoff) em vez de derrubar a VPS.
 */
const POLL_INTERVAL_MS = 2_000;
const MAX_RESOURCE_ATTEMPTS = 5;
const RESOURCE_BACKOFF_BASE_MS = 60_000;
/**
 * Validade do drain: se um update morrer no meio e ninguém liberar, os
 * deploys voltam sozinhos depois deste tempo (nada fica pausado para sempre).
 */
const DRAIN_TTL_MS = 30 * 60 * 1000;

/** O processo existe? (EPERM = existe, mas é de outro usuário). */
function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && (error as NodeJS.ErrnoException).code === "EPERM");
  }
}

/** Lê o PID de um arquivo {pid} (o do runner detached). */
function readPidFromFile(pidFile: string): number | null {
  try {
    const content = JSON.parse(fs.readFileSync(pidFile, "utf-8")) as { pid?: number };
    return typeof content.pid === "number" ? content.pid : null;
  } catch {
    return null;
  }
}

export interface EnqueueParams {
  projectId: string;
  commitSha: string | null;
  branch: string;
  trigger: DeployJobTrigger;
  /** true = reexecuta mesmo que o commit já tenha sido implantado. */
  force?: boolean;
}

export interface EnqueueResult {
  job: DeployJob;
  /** false quando o job já existia (dedupe) - nada foi criado. */
  created: boolean;
  /** true quando o worker está em drain: o job fica na fila, mas não começa. */
  deferred?: boolean;
}

export interface DeployQueueStats {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  interrupted: number;
  canceled: number;
  lastBuildDurationMs: number | null;
  lastDeployDurationMs: number | null;
  lastPreflight: Record<string, number | boolean | null> | null;
  draining: boolean;
}

@Injectable()
export class DeployQueueService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DeployQueueService.name);

  /**
   * Momento em que este processo subiu. Jobs criados ANTES disso (ou seja,
   * enfileirados por uma versão anterior do Korrelo) ficam PAUSADOS: o
   * startup não pode disparar deploy nenhum.
   */
  private readonly processStartedAt = new Date();

  /**
   * Jobs pausados (id). Ficam na fila, mas o worker não os pega até um
   * "resume" explícito - é o que garante que uma atualização do Korrelo não
   * starts deploys que já estavam na fila.
   */
  private readonly pausedJobIds = new Set<string>();
  /** Job esperando por recursos: quando pode tentar de novo. */
  private readonly resourceWaitUntil = new Map<string, number>();

  /** Arquivo de drain (o estado de pausa sobrevive a um restart da API). */
  private readonly drainFilePath =
    process.env.KORRELO_DRAIN_FILE ?? path.join(os.homedir(), ".korrelo", "worker-drain");
  private timer: NodeJS.Timeout | null = null;
  private working = false;
  private draining = false;

  private lastBuildDurationMs: number | null = null;
  private lastDeployDurationMs: number | null = null;
  private lastPreflight: Record<string, number | boolean | null> | null = null;

  constructor(
    @Inject(DEPLOY_JOB_REPOSITORY) private readonly jobRepository: DeployJobRepository,
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    private readonly lock: WorkerLock,
    private readonly preflight: ResourcePreflightService,
    private readonly deployProject: DeployProjectUseCase,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.pausePreExistingJobs();
    await this.recoverInterruptedJobs();
    this.start();
  }

  /**
   * DRAIN: o worker para de INICIAR novos jobs.
   *
   * Usado antes de uma atualização do próprio Korrelo: nenhum deploy de
   * projeto pode começar enquanto o Core está sendo atualizado.
   *
   * O estado é gravado em ARQUIVO (~/.korrelo/worker-drain) e não só em
   * memória, porque o self-update reinicia o processo da API: assim o drain
   * sobrevive ao restart e o worker não retoma sozinho.
   *
   * O arquivo tem validade (DRAIN_TTL_MS): se um update morrer no meio e
   * ninguém liberar o drain, os deploys voltam sozinhos depois do TTL (melhor
   * do que deixar o Korrelo sem deploys para sempre).
   *
   * Wave 3: o arquivo carrega QUEM colocou o drain (owner + updateRunId) e
   * o PID do processo responsável. Se esse PID não existir mais, o drain é
   * órfão (o update morreu com a API) e o worker volta sozinho - em vez de
   * ficar pausado até o TTL.
   */
  async drain(reason: string, owner?: { updateRunId?: string | null; pid?: number; pidFile?: string }): Promise<void> {
    this.draining = true;
    try {
      fs.mkdirSync(path.dirname(this.drainFilePath), { recursive: true });
      fs.writeFileSync(
        this.drainFilePath,
        JSON.stringify({
          at: new Date().toISOString(),
          reason,
          expiresAt: Date.now() + DRAIN_TTL_MS,
          owner: owner?.updateRunId ?? "self-update",
          updateRunId: owner?.updateRunId ?? null,
          pid: owner?.pid ?? process.pid,
          // O runner detached grava o PID dele nesse arquivo (ele ainda não
          // existe quando o drain é criado). O worker resolve o PID real por
          // aqui para saber se o drain ainda tem dono vivo.
          pidFile: owner?.pidFile ?? null,
        }),
      );
      this.logger.warn(`[deploy] worker em DRAINING (${reason}) - nenhum novo deploy começa até liberar`);
    } catch (error) {
      this.logger.warn(`[deploy] não foi possível gravar o arquivo de drain: ${(error as Error).message}`);
    }
  }

  /** Libera o drain (volta a aceitar e executar jobs). */
  async releaseDrain(): Promise<void> {
    this.draining = false;
    try {
      fs.rmSync(this.drainFilePath, { force: true });
    } catch {
      /* best effort */
    }
    this.logger.log("[deploy] worker liberado (drain removido)");
  }

  /** true quando o worker está pausado (memória ou arquivo de drain válido). */
  isDraining(): boolean {
    if (this.draining) return true;
    try {
      if (!fs.existsSync(this.drainFilePath)) return false;
      const content = JSON.parse(fs.readFileSync(this.drainFilePath, "utf-8")) as {
        expiresAt?: number;
        pid?: number;
        pidFile?: string | null;
      };
      if (content.expiresAt && content.expiresAt < Date.now()) {
        // Drain expirado (update morreu no meio): volta a Working sozinho.
        this.logger.warn("[deploy] drain expirado - worker voltando a aceitar jobs");
        try {
          fs.rmSync(this.drainFilePath, { force: true });
        } catch {
          /* best effort */
        }
        return false;
      }
      // Drain órfão: o processo que colocou o drain não existe mais (o
      // update morreu junto com a API). Voltar a Working agora é melhor do
      // que esperar o TTL.
      const ownerPid = content.pidFile ? readPidFromFile(content.pidFile) : content.pid;
      if (typeof ownerPid === "number" && ownerPid > 0 && !isProcessAlive(ownerPid)) {
        this.logger.warn(
          `[deploy] drain órfão (o processo ${ownerPid} não existe mais) - worker voltando a aceitar jobs`,
        );
        try {
          fs.rmSync(this.drainFilePath, { force: true });
        } catch {
          /* best effort */
        }
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * true quando há um deploy EM ANDAMENTO (job em execução ou worker
   * ocupado). Usado para impedir uma atualização do Korrelo no meio de um
   * deploy de projeto.
   */
  async hasActiveJob(): Promise<boolean> {
    if (this.working) return true;
    const running = await this.jobRepository.findAllByStatus("running");
    return running.length > 0;
  }

  onApplicationShutdown(): void {
    // Drenagem: para de pegar jobs novos. O job em andamento continua até
    // terminar (o processo só sai quando o Nest fecha - ver enableShutdownHooks).
    this.draining = true;
    this.stop();
    this.logger.log("[deploy] worker em drenagem: não pega mais jobs novos");
  }

  /**
   * Enfileira um deploy.
   *
   * Dedupe:
   * - webhook (commit conhecido): o mesmo (projeto, commit) não vira dois jobs.
   * - manual: um job em aberto por projeto (commit é resolvido na hora de
   *   rodar, porque no agendamento ainda não sabemos qual commit é).
   */
  async enqueue(params: EnqueueParams): Promise<EnqueueResult> {
    const open = await this.jobRepository.findOpenByProject(params.projectId);
    if (open) {
      const sameCommit = params.commitSha !== null && open.commitSha === params.commitSha;
      if (sameCommit) {
        return { job: open, created: false };
      }
      if (open.status === "running") {
        // Job em andamento: NUNCA é cancelado (não se mexe em build já
        // iniciado). O push novo entra na fila e roda depois.
        return { job: open, created: false };
      }
      if (params.trigger === "webhook") {
        // Coalescência: o job na fila era de um commit superseded.
        this.logger.log(
          `[deploy] job ${open.id} (commit ${open.commitSha ?? "?"}) cancelado: substituído por ${params.commitSha ?? "?"}`,
        );
        const canceled = await this.jobRepository.save(
          open.withError("Substituído por um commit mais novo", "canceled"),
        );
        this.resourceWaitUntil.delete(canceled.id);
      } else {
        return { job: open, created: false };
      }
    }

    if (params.commitSha) {
      const existing = await this.jobRepository.findByProjectAndCommit(params.projectId, params.commitSha);
      if (existing) {
        if (existing.status === "succeeded" && !params.force) {
          // Já implantado: não é job novo.
          return { job: existing, created: false };
        }
        // Retry controlado: o mesmo commit volta pra fila.
        const requeued = existing.requeued();
        this.logger.log(`[deploy] job ${existing.id} reativado (tentativa ${existing.attempt + 1})`);
        const saved = await this.jobRepository.save(requeued);
        this.kick();
        return { job: saved, created: true };
      }
    }

    const job = DeployJob.create({
      projectId: params.projectId,
      commitSha: params.commitSha,
      branch: params.branch,
      trigger: params.trigger,
    });
    const created = await this.jobRepository.create(job);
    const deferred = this.isDraining();
    this.logger.log(
      `[deploy] job ${created.id} enfileirado (projeto ${created.projectId}, commit ${created.commitSha ?? "?"}, gatilho ${created.trigger})`,
    );
    if (!deferred) this.kick();
    return { job: created, created: true, deferred };
  }

  /** Reexecuta um job interrompido/falho (retry controlado pela UI). */
  async retry(jobId: string): Promise<EnqueueResult | null> {
    const job = await this.jobRepository.findById(jobId);
    if (!job) return null;
    if (job.isOpen) return { job, created: false };

    const requeued = await this.jobRepository.save(job.requeued());
    this.kick();
    return { job: requeued, created: true };
  }

  async getStats(): Promise<DeployQueueStats> {
    const [queued, running, succeeded, failed, interrupted, canceled, recent] = await Promise.all([
      this.jobRepository.countByStatus("queued"),
      this.jobRepository.countByStatus("running"),
      this.jobRepository.countByStatus("succeeded"),
      this.jobRepository.countByStatus("failed"),
      this.jobRepository.countByStatus("interrupted"),
      this.jobRepository.countByStatus("canceled"),
      this.jobRepository.findRecent(1),
    ]);
    const last = recent[0];
    return {
      queued,
      running,
      succeeded,
      failed,
      interrupted,
      canceled,
      lastBuildDurationMs: last?.buildDurationMs ?? this.lastBuildDurationMs,
      lastDeployDurationMs: last?.deployDurationMs ?? this.lastDeployDurationMs,
      lastPreflight: this.lastPreflight,
      draining: this.draining,
    };
  }

  async findRecent(limit = 20): Promise<DeployJob[]> {
    return this.jobRepository.findRecent(limit);
  }

  /**
   * Jobs enfileirados ANTES do startup deste processo ficam PAUSADOS.
   *
   * Motivo (Objetivo 9 da Wave 2.1): atualizar/reiniciar o Korrelo não pode
   * disparar deploy nenhum. Um job antigo pode ter sido criado por uma
   * versão anterior do Korrelo (estado incompatível), por um projeto que
   * desde então mudou, ou simplesmente ser um push de antes do upgrade. Ele
   * só volta a rodar com um "resume" explícito (admin) - e, antes disso, a
   * reconciliação de runtime acontece e valida o estado.
   */
  async pausePreExistingJobs(): Promise<void> {
    const queued = await this.jobRepository.findAllByStatus("queued");
    const preExisting = queued.filter((job) => job.createdAt.getTime() < this.processStartedAt.getTime());
    if (preExisting.length === 0) return;

    for (const job of preExisting) {
      this.pausedJobIds.add(job.id);
      await this.jobRepository.save(
        job.withError(
          "Pausado: o job foi enfileirado antes da última atualização do Korrelo. Retome explicitamente após conferir o estado do projeto.",
          "queued",
        ),
      );
    }
    this.logger.warn(
      `[deploy] ${preExisting.length} job(s) enfileirado(s) antes do startup foram PAUSADOS (nenhum deploy é disparado automaticamente). ` +
        "Retome com POST /deploy-jobs/:id/resume depois de conferir o estado.",
    );
  }

  /** Retoma (libera) um job pausado. Ação explícita do administrador. */
  async resume(jobId: string): Promise<EnqueueResult | null> {
    const job = await this.jobRepository.findById(jobId);
    if (!job) return null;
    this.pausedJobIds.delete(jobId);
    if (job.status === "queued") {
      this.kick();
    }
    return { job, created: false };
  }

  /** Jobs pausados no momento (diagnóstico). */
  listPausedJobIds(): string[] {
    return [...this.pausedJobIds];
  }

  /**
   * Startup recovery: job "running" quando a API morreu vira "interrupted".
   * Não reexecutamos sozinho (decisão do operador), mas o job continua
   * visível e pode ser reativado pela UI.
   */
  async recoverInterruptedJobs(): Promise<void> {
    const running = await this.jobRepository.findAllByStatus("running");
    for (const job of running) {
      this.logger.warn(
        `[deploy] job ${job.id} (projeto ${job.projectId}) estava "running" quando a API caiu - marcado como interrupted`,
      );
      await this.jobRepository.save(
        job.withError("A API reiniciou durante o deploy (job interrompido)", "interrupted"),
      );
    }
    if (running.length > 0) {
      this.logger.warn(`[deploy] ${running.length} job(s) interrompido(s) precisam de retry manual.`);
    }
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.processNextJob();
    }, POLL_INTERVAL_MS);
    // Dispara um tick logo no boot: um job enfileirado antes do restart
    // começa a rodar sem esperar o intervalo.
    void this.processNextJob();
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Dispara um tick logo no boot: um job enfileirado antes do restart
   *  começa a rodar sem esperar o intervalo. */
  private kick(): void {
    setTimeout(() => {
      void this.processNextJob();
    }, 0);
  }

  /**
   * Processa o PRÓXIMO job da fila (se houver).
   *
   * Público porque é o ponto de entrada do worker (e o que os testes
   * chamam para exercitar a fila sem depender de timer).
   */
  async processNextJob(): Promise<void> {
    // Em drain (atualização do Korrelo), nenhum job novo começa.
    if (this.isDraining()) return;
    if (this.working) return;

    // A trava é tomada ANTES de qualquer await: dois ticks que se
    // sobrepusessem (o timer + o kick após enfileirar) poderiam passar
    // juntos pelo check acima e rodar o MESMO job duas vezes.
    this.working = true;
    try {
      // Lock entre PROCESSOS: se outra instância da API já está trabalhando,
      // esta não compete.
      const acquired = await this.lock.acquire();
      if (!acquired) return;

      try {
        const job = await this.jobRepository.findNextQueued([...this.pausedJobIds]);
        if (!job) return;

        const waitUntil = this.resourceWaitUntil.get(job.id);
        if (waitUntil && waitUntil > Date.now()) {
          return;
        }

        await this.runJob(job);
      } finally {
        await this.lock.release();
      }
    } catch (error) {
      this.logger.error(`[deploy] erro no worker da fila: ${(error as Error).message}`);
    } finally {
      this.working = false;
    }
  }

  /**
   * Soma dos limites de PRODUÇÃO já em uso (o que é intocável durante um
   * build). Vem do que a reconciliação observou no Docker.
   */
  private async sumProductionReservation(): Promise<number> {
    const projects = await this.projectRepository.findAll();
    return projects
      .filter((project) => project.status === "running")
      .reduce((sum, project) => sum + (project.productionMemoryLimitMb ?? 0), 0);
  }

  private async runJob(job: DeployJob): Promise<void> {
    // O preflight precisa saber quanto o container de teste vai reservar e
    // quanto a PRODUÇÃO existente já reservou (produção tem prioridade
    // máxima: nunca é reduzida pra "cabar" espaço de build).
    let stagingReservationMb = 0;
    let productionReservedMb = 0;
    try {
      const reservation = await this.deployProject.estimateMemoryReservation(job.projectId);
      stagingReservationMb = reservation.stagingLimitMb;
      productionReservedMb = await this.sumProductionReservation();
    } catch (error) {
      this.logger.warn(
        `[deploy] não foi possível estimar a reserva de memória do projeto ${job.projectId}: ${(error as Error).message}`,
      );
    }

    const preflight = await this.preflight.check({
      activeBuilds: 0,
      stagingReservationMb,
      productionReservedMb,
    });
    this.lastPreflight = { ...(preflight.metrics as unknown as Record<string, number | boolean | null>) };

    if (!preflight.ok) {
      const attempt = job.attempt + 1;
      if (attempt >= MAX_RESOURCE_ATTEMPTS) {
        this.logger.error(
          `[deploy] job ${job.id} (projeto ${job.projectId}) falhou por falta de recursos após ${attempt} tentativas: ${preflight.reason}`,
        );
        await this.jobRepository.save(job.withAttempt(attempt).withError(`Recursos insuficientes: ${preflight.reason}`));
        this.resourceWaitUntil.delete(job.id);
        return;
      }
      const backoffMs = RESOURCE_BACKOFF_BASE_MS * attempt;
      this.resourceWaitUntil.set(job.id, Date.now() + backoffMs);
      this.logger.warn(
        `[deploy] job ${job.id} (projeto ${job.projectId}) aguardando recursos: ${preflight.reason} (nova tentativa em ${Math.round(backoffMs / 1000)}s)`,
      );
      await this.jobRepository.save(
        job.withAttempt(attempt).withStage("waiting-resources").withError(preflight.reason ?? "sem recursos", "queued"),
      );
      return;
    }

    const startedAt = new Date();
    // Re-lê o job antes de começar: se ele já não está "queued" (outro
    // worker pegou, ou alguém cancelou), não roda de novo.
    const current = await this.jobRepository.findById(job.id);
    if (!current || current.status !== "queued") {
      return;
    }

    const running = current
      .withStatus("running")
      .withStage("queued")
      .withAttempt(current.attempt + 1)
      .withStartedAt(startedAt);
    await this.jobRepository.save(running);
    this.resourceWaitUntil.delete(job.id);

    this.logger.log(
      `[deploy] job ${running.id} iniciado (projeto ${running.projectId}, commit ${running.commitSha ?? "?"})`,
    );

    try {
      await this.deployProject.executeJob(running);
      this.lastDeployDurationMs = Date.now() - startedAt.getTime();
      const finished = (await this.jobRepository.findById(running.id)) ?? running;
      await this.jobRepository.save(
        finished.withDurations(finished.buildDurationMs, this.lastDeployDurationMs),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[deploy] job ${running.id} falhou: ${message}`);
      const current = (await this.jobRepository.findById(running.id)) ?? running;
      this.lastDeployDurationMs = Date.now() - startedAt.getTime();
      await this.jobRepository.save(
        current.withError(message).withDurations(current.buildDurationMs, this.lastDeployDurationMs),
      );
    }
  }
}
