import type { SelfUpdateJob } from "./self-update-job.entity";

export const SELF_UPDATER = Symbol("SELF_UPDATER");

export interface SelfUpdateStatus {
  running: boolean;
  percent: number;
  label: string;
  done: boolean;
  success: boolean | null;
  errorMessage?: string;
  log: string;
  /** Job persistente (Wave 3) - a UI usa isso para retomar após reload. */
  jobId?: string | null;
  jobStatus?: string | null;
  currentStage?: string | null;
  previousCommit?: string | null;
  candidateCommit?: string | null;
  previousBranch?: string | null;
  recoveryStatus?: string | null;
  /** true quando o runner foi interrompido (processo morto). */
  interrupted?: boolean;
  /**
   * true quando o executor está AGUARDANDO recursos da VPS (load/swap/
   * MemAvailable) - não está travado, está esperando o host normalizar.
   *
   * Inferido do log que o runner já grava (nada novo é persistido): o
   * guard escreve "[rollout] <label>: aguardando recursos" e só escreve
   * "recursos normalizados" quando o host volta ao normal.
   */
  waiting?: boolean;
  /**
   * Detalhes da espera, exatamente como o executor mediu (ex.:
   * "swap em uso=601 MB (limite 512)"). Nenhum número é inventado: se o
   * executor não mediu, não aparece nada.
   */
  waitingDetails?: string[] | null;
  /** "próxima checagem em Ns" - o tempo que falta para a nova tentativa. */
  nextRetryInSeconds?: number | null;
  /** Início do job (ISO) - a UI calcula o tempo decorrido sem consultar o backend. */
  startedAt?: string | null;
  /** Fim do job (ISO), quando terminou. */
  finishedAt?: string | null;
  /** Progresso persistido pelo runner (0-100). */
  progress?: number;
  /** Última mensagem do runner (já sanitizada). */
  lastMessage?: string | null;
}

export interface SelfUpdater {
  /** Inicia o update num processo DESACOPLADO e volta rápido. */
  start(): Promise<{ alreadyRunning: boolean; jobId: string; status: string }>;
  getStatus(): Promise<SelfUpdateStatus>;
  getJob(id: string): Promise<SelfUpdateJob | null>;
  getJobLog(id: string): Promise<string>;
  /** Classifica jobs interrompidos (chamado no startup da API). */
  recoverInterruptedJobs(): Promise<SelfUpdateJob[]>;
}
