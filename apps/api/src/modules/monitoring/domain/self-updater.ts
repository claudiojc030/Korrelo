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
