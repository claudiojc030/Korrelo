export const DATABASE_RESTORER = Symbol("DATABASE_RESTORER");

export interface DatabaseRestoreStatus {
  running: boolean;
  label: string;
  done: boolean;
  success: boolean | null;
  errorMessage?: string;
  log: string;
  /** Bytes já escritos/ processados no job (quando disponível). */
  bytesWritten?: number;
  /** Epoch ms do início do job. */
  startedAt?: number | null;
  /** Epoch ms da última atualização de progresso (heartbeat). */
  lastProgressAt?: number | null;
}

export interface StartRestoreOptions {
  containerName: string;
  dbType: "postgres" | "mongodb" | "redis";
  username: string | null;
  password: string | null;
  databaseName: string | null;
  backupFilePath: string;
}

export interface DatabaseRestorer {
  start(projectId: string, options: StartRestoreOptions): Promise<{ alreadyRunning: boolean }>;
  getStatus(projectId: string): Promise<DatabaseRestoreStatus>;
}
