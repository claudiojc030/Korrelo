/**
 * JOB DE SELF-UPDATE (persistente).
 *
 * O update do Core reinicia a própria API e o próprio Web. Se o estado do
 * update vivesse só na memória do processo (ou no arquivo de lock), o
 * reinício apagaria a informação e o lock/drain ficariam órfãos.
 *
 * O job é gravado em ARQUIVO (~/.korrelo/self-update/<id>.json) porque:
 * - não depende do banco do Core (que pode estar em migration);
 * - sobrevive ao restart da API e do Web;
 * - permite consultar o progresso depois (GET /self-update/:id);
 * - permite classificar um update interrompido no startup (A12).
 */

export type SelfUpdateJobStatus =
  | "queued"
  | "running"
  | "restarting"
  | "verifying"
  | "completed"
  | "failed"
  | "recovery_deferred"
  | "recovery_required"
  | "interrupted";

export interface SelfUpdateJob {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: SelfUpdateJobStatus;
  /** Commit do código que EXECUTOU o update (pode ser outro do alvo). */
  executorCommit: string | null;
  /** Commit que estava no checkout alvo antes do update. */
  previousCommit: string | null;
  /** Commit candidato (origin/main do alvo). */
  candidateCommit: string | null;
  /** Branch do checkout alvo antes do update. */
  previousBranch: string | null;
  currentStage: string | null;
  /** 0-100 */
  progress: number;
  /** PID do processo detached que executa o rollout. */
  pid: number | null;
  /** Resultado final ("success" | "failed" | null enquanto roda). */
  result: string | null;
  failureReason: string | null;
  /** Estado da recuperação (deferred/required) quando o update falhou. */
  recoveryStatus: string | null;
  /** Mensagem mais recente do runner (sanitizada). */
  lastMessage: string | null;
  /** Última vez que o job foi gravado (runner ou API). */
  updatedAt?: string | null;
}

export const SELF_UPDATE_JOB_REPOSITORY = Symbol("SELF_UPDATE_JOB_REPOSITORY");

export interface SelfUpdateJobRepository {
  save(job: SelfUpdateJob): Promise<SelfUpdateJob>;
  findById(id: string): Promise<SelfUpdateJob | null>;
  /** Job mais recente (o "current"). */
  findLatest(): Promise<SelfUpdateJob | null>;
  list(limit?: number): Promise<SelfUpdateJob[]>;
}

export function createSelfUpdateJob(id: string, now = new Date()): SelfUpdateJob {
  return {
    id,
    startedAt: now.toISOString(),
    finishedAt: null,
    status: "queued",
    executorCommit: null,
    previousCommit: null,
    candidateCommit: null,
    previousBranch: null,
    currentStage: null,
    progress: 0,
    pid: null,
    result: null,
    failureReason: null,
    recoveryStatus: null,
    lastMessage: null,
  };
}
