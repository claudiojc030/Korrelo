export const SELF_UPDATER = Symbol("SELF_UPDATER");

export interface SelfUpdateStatus {
  running: boolean;
  percent: number;
  label: string;
  done: boolean;
  success: boolean | null;
  errorMessage?: string;
  log: string;
}

export interface SelfUpdater {
  start(): Promise<{ alreadyRunning: boolean }>;
  getStatus(): Promise<SelfUpdateStatus>;
}
