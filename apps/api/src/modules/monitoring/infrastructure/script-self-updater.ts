import { Inject, Injectable, Logger } from "@nestjs/common";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SelfUpdater, SelfUpdateStatus } from "../domain/self-updater";
import {
  createSelfUpdateJob,
  SELF_UPDATE_JOB_REPOSITORY,
  type SelfUpdateJob,
  type SelfUpdateJobRepository,
} from "../domain/self-update-job.entity";
import { formatDirtyWorkingTreeMessage, inspectWorkingTree } from "../../../infrastructure/git-working-tree";
import { DeployQueueService } from "../../projects/infrastructure/deploy-queue.service";
import { FileSelfUpdateJobRepository } from "./file-self-update-job.repository";

const STEP_MARKER = "__KORRELO_UPDATE_STEP__";
const DONE_MARKER = "__KORRELO_UPDATE_DONE__";

/**
 * Self-update do KORRELO - Wave 3: DESACOPLADO.
 *
 * O update do Core reinicia a própria API e o próprio Web. Antes, o rollout
 * era filho do processo da API: o `pm2 restart korrelo-api` matava a árvore
 * da API e o rollout morria junto (lock órfão, drain órfão, snapshot-after /
 * compare-projects / git-verify / worker-release nunca aconteciam).
 *
 * Agora o update roda num processo DETACHED, re-parentado para o init:
 * sobrevive ao restart da API, ao restart do Web, ao fechamento do
 * navegador e à queda do WebSocket.
 *
 * O que ele NUNCA pode:
 * - rodar no meio de um deploy de projeto (bloqueia se houver);
 * - descartar alteração local do working tree (aborta se estiver sujo);
 * - tocar em container, volume, rede ou banco de projeto (o script só
 *   builda o Core).
 */
@Injectable()
export class ScriptSelfUpdater implements SelfUpdater {
  private readonly logger = new Logger(ScriptSelfUpdater.name);

  constructor(
    private readonly deployQueue: DeployQueueService,
    @Inject(SELF_UPDATE_JOB_REPOSITORY) private readonly jobs: SelfUpdateJobRepository,
  ) {}

  private get stateDir(): string {
    // KORRELO_STATE_DIR permite apontar para outro lugar (testes).
    return process.env.KORRELO_STATE_DIR ?? path.join(os.homedir(), ".korrelo");
  }

  private get logPath(): string {
    return path.join(this.stateDir, "update.log");
  }

  private get repoDir(): string {
    // ecosystem.config.js roda a API com cwd "./apps/api" a partir da raiz do
    // repo (mesmo em dev, "npm run start:dev --workspace=apps/api" tem o
    // mesmo cwd), então subir dois níveis sempre chega na raiz.
    // KORRELO_REPO_DIR permite apontar para outro lugar (testes).
    return process.env.KORRELO_REPO_DIR
      ? path.resolve(process.env.KORRELO_REPO_DIR)
      : path.resolve(process.cwd(), "..", "..");
  }

  /** Caminho do launcher detached (double fork). */
  private get launcherPath(): string {
    return path.join(this.repoDir, "apps", "api", "scripts", "self-update", "launch-detached.cjs");
  }

  async start(): Promise<{ alreadyRunning: boolean; jobId: string; status: string }> {
    const current = await this.getCurrentJob();
    if (current && this.isJobActive(current)) {
      return { alreadyRunning: true, jobId: current.id, status: current.status };
    }

    // ------------------------------------------------------------------
    // 1. Working tree limpo? (o caso real: package-lock.json modificado)
    // ------------------------------------------------------------------
    const workingTree = await inspectWorkingTree(this.repoDir);
    if (!workingTree.clean) {
      // NÃO descarta nada - aborta e explica.
      throw new Error(formatDirtyWorkingTreeMessage(workingTree));
    }

    // ------------------------------------------------------------------
    // 2. Nenhum deploy de projeto em andamento
    // ------------------------------------------------------------------
    if (await this.deployQueue.hasActiveJob()) {
      throw new Error(
        "Existe um deploy de projeto em andamento: a atualização do Korrelo foi recusada. " +
          "Nenhum rollout do Core começa no meio de um deploy - tente novamente assim que o deploy terminar.",
      );
    }

    // ------------------------------------------------------------------
    // 3. DRAIN: nenhum novo deploy começa até o update terminar
    //
    // O drain aponta para o arquivo de PID do runner detached (ele é quem
    // realmente segura o update). Se o runner morrer, o drain é órfão e o
    // worker volta a aceitar jobs (sem esperar o TTL).
    // ------------------------------------------------------------------
    const job = createSelfUpdateJob(this.newJobId());
    await this.jobs.save(job);

    const scriptPath = path.join(this.repoDir, "scripts", "self-update.sh");
    const jobRepo = this.jobs as FileSelfUpdateJobRepository;
    const logFile = jobRepo.logPath(job.id);
    const pidFile = path.join(jobRepo.baseDir, `${job.id}.pid`);

    await this.deployQueue.drain("atualização do Korrelo", { updateRunId: job.id, pidFile });

    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.writeFileSync(this.logPath, "");

    // O PM2 roda a API com NODE_ENV=production (ver ecosystem.config.js), e
    // isso é herdado pelo processo filho por padrão. Com NODE_ENV=production
    // no ambiente, o npm roda com omit=dev e as devDependencies (typescript
    // entre elas) não são instaladas - o build do Core quebra sem "tsc". O
    // rollout usa `npm ci --include=dev` (a flag vence o omit=dev), mas o
    // NODE_ENV é limpo aqui para não vazar para outros passos.
    const updateEnv = { ...process.env };
    delete updateEnv.NODE_ENV;

    // O launcher faz o DOUBLE FORK: o rollout é re-parentado para o init e
    // sobrevive ao `pm2 restart korrelo-api` (que mata a árvore da API).
    const child = spawn(
      process.execPath,
      [
        this.launcherPath,
        "--pid-file",
        pidFile,
        "--log-file",
        logFile,
        "--job-file",
        jobRepo.jobPath(job.id),
        "--cwd",
        this.repoDir,
        "--",
        "bash",
        scriptPath,
      ],
      {
        cwd: this.repoDir,
        detached: true,
        stdio: "ignore",
        env: updateEnv,
      },
    );
    child.unref();

    // O PID do runner (o launcher escreve o arquivo). Serve para:
    // - saber se o update ainda está vivo (job "running" vs "interrupted");
    // - o drain saber se ainda tem dono.
    const runnerPid = await this.waitForRunnerPid(pidFile);
    await this.jobs.save({ ...job, pid: runnerPid, status: runnerPid ? "running" : "queued" });

    this.logger.log(
      `[update] self-update disparado (job ${job.id}, runner pid ${runnerPid ?? "?"}, launcher pid ${child.pid})`,
    );
    return { alreadyRunning: false, jobId: job.id, status: runnerPid ? "running" : "queued" };
  }

  /** Espera (pouco) o launcher gravar o PID do runner. */
  private async waitForRunnerPid(pidFile: string, timeoutMs = 2000): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const content = JSON.parse(fs.readFileSync(pidFile, "utf-8")) as { pid?: number };
        if (typeof content.pid === "number" && content.pid > 0) return content.pid;
      } catch {
        /* ainda não gravado */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  }

  async getStatus(): Promise<SelfUpdateStatus> {
    const job = await this.getCurrentJob();
    if (!job) {
      return { running: false, percent: 0, label: "", done: false, success: null, log: "" };
    }
    return this.statusFromJob(job);
  }

  async getJob(id: string): Promise<SelfUpdateJob | null> {
    return this.jobs.findById(id);
  }

  async getJobLog(id: string): Promise<string> {
    const repo = this.jobs as FileSelfUpdateJobRepository;
    return repo.readLog(id);
  }

  /**
   * Startup da API: classifica jobs cujo runner morreu.
   *
   * - o runner ainda está vivo -> continua "running" (nada a fazer);
   * - o runner morreu MAS o log tem o marcador de conclusão -> o update
   *   terminou (completed/failed);
   * - o runner morreu SEM marcador -> "interrupted" (e o recovery status
   *   vai para recovery_required, porque ninguém sabe em que stage parou).
   *
   * Nunca toca em container de projeto.
   */
  async recoverInterruptedJobs(): Promise<SelfUpdateJob[]> {
    const recovered: SelfUpdateJob[] = [];
    const jobs = await this.jobs.list(20);
    for (const job of jobs) {
      if (!this.isJobActive(job)) continue;
      if (this.isRunnerAlive(job)) continue;

      const log = await this.getJobLog(job.id);
      const parsed = this.parseLog(log);
      const updated: SelfUpdateJob = {
        ...job,
        status: parsed.done ? (parsed.success ? "completed" : "failed") : "interrupted",
        finishedAt: job.finishedAt ?? new Date().toISOString(),
        progress: parsed.done ? 100 : job.progress,
        currentStage: parsed.done ? job.currentStage : job.currentStage,
        result: parsed.done ? (parsed.success ? "success" : "failed") : job.result,
        failureReason: parsed.done
          ? parsed.success
            ? null
            : (parsed.errorMessage ?? "o processo de atualização terminou com falha")
          : "o processo de atualização foi interrompido (processo encerrado sem conclusão)",
        recoveryStatus: parsed.done ? null : "recovery_required",
        lastMessage: parsed.done ? (parsed.errorMessage ?? job.lastMessage) : job.lastMessage,
      };
      await this.jobs.save(updated);
      recovered.push(updated);
      this.logger.warn(
        `[update] job ${job.id} classificado como ${updated.status} (o processo do runner não existe mais)`,
      );
    }
    return recovered;
  }

  /** Job mais recente (com o log já lido). */
  private async getCurrentJob(): Promise<SelfUpdateJob | null> {
    return this.jobs.findLatest();
  }

  /** Um job está ativo enquanto o runner estiver vivo. */
  private isJobActive(job: SelfUpdateJob): boolean {
    return ["queued", "running", "restarting", "verifying"].includes(job.status);
  }

  /** O processo do runner ainda existe? */
  private isRunnerAlive(job: SelfUpdateJob): boolean {
    if (!job.pid) return false;
    try {
      process.kill(job.pid, 0);
      return true;
    } catch (error) {
      // EPERM = o processo existe, mas não é nosso.
      return Boolean(error && (error as NodeJS.ErrnoException).code === "EPERM");
    }
  }

  private statusFromJob(job: SelfUpdateJob): SelfUpdateStatus {
    const log = this.getJobLogSync(job.id);
    const parsed = this.parseLog(log);
    // O progresso vem do JOB PERSISTIDO (o runner é quem o atualiza, mesmo
    // com a API reiniciando no meio). O log é o fallback quando o job ainda
    // não tem progresso gravado.
    const percent = job.progress > 0 ? job.progress : parsed.percent;
    const label = job.currentStage ?? parsed.label ?? "";
    const status: SelfUpdateStatus = {
      running: this.isJobActive(job) && this.isRunnerAlive(job),
      percent: parsed.done ? 100 : percent,
      label,
      done: parsed.done || ["completed", "failed", "interrupted"].includes(job.status),
      success: parsed.done ? parsed.success : job.status === "completed" ? true : null,
      errorMessage: parsed.errorMessage ?? job.failureReason ?? undefined,
      log,
      jobId: job.id,
      jobStatus: job.status,
      currentStage: job.currentStage ?? parsed.label ?? null,
      previousCommit: job.previousCommit,
      candidateCommit: job.candidateCommit,
      previousBranch: job.previousBranch,
      recoveryStatus: job.recoveryStatus,
      interrupted: job.status === "interrupted",
    };
    return status;
  }

  private getJobLogSync(id: string): string {
    const repo = this.jobs as FileSelfUpdateJobRepository;
    return repo.readLog(id);
  }

  private newJobId(): string {
    return `upd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private parseLog(log: string): Omit<SelfUpdateStatus, "running"> {
    const lines = log.split("\n").filter(Boolean);
    let percent = 0;
    let label = "";
    let done = false;
    let success: boolean | null = null;
    let errorMessage: string | undefined;

    for (const line of lines) {
      if (line.startsWith(STEP_MARKER)) {
        const [, pct, lbl] = line.split("|");
        percent = Number.parseInt(pct, 10) || percent;
        label = lbl ?? label;
      } else if (line.startsWith(DONE_MARKER)) {
        const [, outcome, message] = line.split("|");
        done = true;
        success = outcome === "success";
        errorMessage = message;
      }
    }

    return { percent, label, done, success, errorMessage, log };
  }
}
