/**
 * Fila global de deploy.
 *
 * Um job = UM deploy agendado. O worker roda UM job por vez na VPS inteira
 * (concorrência global = 1) - é o que impede dois builds simultâneos, que
 * era a causa mais provável da queda de 19/10/2026.
 *
 * Estados:
 *  - queued     : na fila, esperando vez (e recursos)
 *  - running    : em execução (o worker segura o job)
 *  - succeeded  : promoteu e passou no health check de produção
 *  - failed     : falhou (com ou sem rollback)
 *  - canceled   : superseded por um commit mais novo, ou cancelado
 *  - interrupted: a API morreu com o job em andamento (recuperado no boot)
 */
export type DeployJobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled" | "interrupted";

/** Etapas finer-grained, usadas nos logs estruturados e na UI. */
export type DeployJobStage =
  | "queued"
  | "waiting-resources"
  | "fetching"
  | "building"
  | "staging-start"
  | "staging-health"
  | "promote"
  | "production-health"
  | "rollback"
  | "cleanup"
  | "complete";

export type DeployJobTrigger = "manual" | "webhook" | "staging";

export class DeployJob {
  constructor(
    public readonly id: string,
    public readonly projectId: string,
    public readonly commitSha: string | null,
    public readonly branch: string,
    public readonly trigger: DeployJobTrigger,
    public readonly status: DeployJobStatus,
    public readonly attempt: number,
    public readonly stage: DeployJobStage | null,
    public readonly errorMessage: string | null,
    public readonly log: string,
    public readonly previousImage: string | null,
    public readonly candidateImage: string | null,
    public readonly rollbackAttempted: boolean,
    public readonly rollbackSucceeded: boolean,
    public readonly imageTag: string | null,
    public readonly buildDurationMs: number | null,
    public readonly deployDurationMs: number | null,
    public readonly createdAt: Date,
    public readonly startedAt: Date | null,
    public readonly finishedAt: Date | null,
  ) {}

  static create(params: {
    projectId: string;
    commitSha: string | null;
    branch: string;
    trigger: DeployJobTrigger;
  }): DeployJob {
    return new DeployJob(
      crypto.randomUUID(),
      params.projectId,
      params.commitSha,
      params.branch,
      params.trigger,
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
      new Date(),
      null,
      null,
    );
  }

  withStatus(status: DeployJobStatus): DeployJob {
    return new DeployJob(
      this.id,
      this.projectId,
      this.commitSha,
      this.branch,
      this.trigger,
      status,
      this.attempt,
      this.stage,
      this.errorMessage,
      this.log,
      this.previousImage,
      this.candidateImage,
      this.rollbackAttempted,
      this.rollbackSucceeded,
      this.imageTag,
      this.buildDurationMs,
      this.deployDurationMs,
      this.createdAt,
      this.startedAt,
      this.finishedAt,
    );
  }

  withStage(stage: DeployJobStage): DeployJob {
    return new DeployJob(
      this.id,
      this.projectId,
      this.commitSha,
      this.branch,
      this.trigger,
      this.status,
      this.attempt,
      stage,
      this.errorMessage,
      this.log,
      this.previousImage,
      this.candidateImage,
      this.rollbackAttempted,
      this.rollbackSucceeded,
      this.imageTag,
      this.buildDurationMs,
      this.deployDurationMs,
      this.createdAt,
      this.startedAt,
      this.finishedAt,
    );
  }

  withCommit(commitSha: string): DeployJob {
    return new DeployJob(
      this.id,
      this.projectId,
      commitSha,
      this.branch,
      this.trigger,
      this.status,
      this.attempt,
      this.stage,
      this.errorMessage,
      this.log,
      this.previousImage,
      this.candidateImage,
      this.rollbackAttempted,
      this.rollbackSucceeded,
      this.imageTag,
      this.buildDurationMs,
      this.deployDurationMs,
      this.createdAt,
      this.startedAt,
      this.finishedAt,
    );
  }

  withImageInfo(params: {
    previousImage?: string | null;
    candidateImage?: string | null;
    imageTag?: string | null;
  }): DeployJob {
    return new DeployJob(
      this.id,
      this.projectId,
      this.commitSha,
      this.branch,
      this.trigger,
      this.status,
      this.attempt,
      this.stage,
      this.errorMessage,
      this.log,
      params.previousImage !== undefined ? params.previousImage : this.previousImage,
      params.candidateImage !== undefined ? params.candidateImage : this.candidateImage,
      this.rollbackAttempted,
      this.rollbackSucceeded,
      params.imageTag !== undefined ? params.imageTag : this.imageTag,
      this.buildDurationMs,
      this.deployDurationMs,
      this.createdAt,
      this.startedAt,
      this.finishedAt,
    );
  }

  /** Durações do build e do deploy (métricas internas). */
  withDurations(buildDurationMs: number | null, deployDurationMs: number | null): DeployJob {
    return new DeployJob(
      this.id,
      this.projectId,
      this.commitSha,
      this.branch,
      this.trigger,
      this.status,
      this.attempt,
      this.stage,
      this.errorMessage,
      this.log,
      this.previousImage,
      this.candidateImage,
      this.rollbackAttempted,
      this.rollbackSucceeded,
      this.imageTag,
      buildDurationMs,
      deployDurationMs,
      this.createdAt,
      this.startedAt,
      this.finishedAt,
    );
  }

  withRollback(attempted: boolean, succeeded: boolean): DeployJob {
    return new DeployJob(
      this.id,
      this.projectId,
      this.commitSha,
      this.branch,
      this.trigger,
      this.status,
      this.attempt,
      this.stage,
      this.errorMessage,
      this.log,
      this.previousImage,
      this.candidateImage,
      attempted,
      succeeded,
      this.imageTag,
      this.buildDurationMs,
      this.deployDurationMs,
      this.createdAt,
      this.startedAt,
      this.finishedAt,
    );
  }

  withError(errorMessage: string, status: DeployJobStatus = "failed"): DeployJob {
    return new DeployJob(
      this.id,
      this.projectId,
      this.commitSha,
      this.branch,
      this.trigger,
      status,
      this.attempt,
      this.stage,
      errorMessage,
      this.log,
      this.previousImage,
      this.candidateImage,
      this.rollbackAttempted,
      this.rollbackSucceeded,
      this.imageTag,
      this.buildDurationMs,
      this.deployDurationMs,
      this.createdAt,
      this.startedAt,
      status === "queued" ? null : new Date(),
    );
  }

  withAttempt(attempt: number): DeployJob {
    return new DeployJob(
      this.id,
      this.projectId,
      this.commitSha,
      this.branch,
      this.trigger,
      this.status,
      attempt,
      this.stage,
      this.errorMessage,
      this.log,
      this.previousImage,
      this.candidateImage,
      this.rollbackAttempted,
      this.rollbackSucceeded,
      this.imageTag,
      this.buildDurationMs,
      this.deployDurationMs,
      this.createdAt,
      this.startedAt,
      this.finishedAt,
    );
  }

  withStartedAt(startedAt: Date): DeployJob {
    return new DeployJob(
      this.id,
      this.projectId,
      this.commitSha,
      this.branch,
      this.trigger,
      this.status,
      this.attempt,
      this.stage,
      this.errorMessage,
      this.log,
      this.previousImage,
      this.candidateImage,
      this.rollbackAttempted,
      this.rollbackSucceeded,
      this.imageTag,
      this.buildDurationMs,
      this.deployDurationMs,
      this.createdAt,
      startedAt,
      this.finishedAt,
    );
  }

  appendLog(chunk: string): DeployJob {
    const log = this.log ? `${this.log}\n${chunk}` : chunk;
    return new DeployJob(
      this.id,
      this.projectId,
      this.commitSha,
      this.branch,
      this.trigger,
      this.status,
      this.attempt,
      this.stage,
      this.errorMessage,
      log,
      this.previousImage,
      this.candidateImage,
      this.rollbackAttempted,
      this.rollbackSucceeded,
      this.imageTag,
      this.buildDurationMs,
      this.deployDurationMs,
      this.createdAt,
      this.startedAt,
      this.finishedAt,
    );
  }

  /** true quando o job ainda pode ser executado. */
  get isOpen(): boolean {
    return this.status === "queued" || this.status === "running";
  }

  /**
   * Reativa o job para a fila (retry controlado): zera o estado de execução,
   * incrementa a tentativa e limpa o erro anterior. O histórico do job
   * (log) é preservado.
   */
  requeued(): DeployJob {
    return new DeployJob(
      this.id,
      this.projectId,
      this.commitSha,
      this.branch,
      this.trigger,
      "queued",
      this.attempt + 1,
      "queued",
      null,
      this.log,
      this.previousImage,
      this.candidateImage,
      this.rollbackAttempted,
      this.rollbackSucceeded,
      this.imageTag,
      this.buildDurationMs,
      this.deployDurationMs,
      this.createdAt,
      null,
      null,
    );
  }
}
