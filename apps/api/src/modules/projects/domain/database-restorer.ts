export const DATABASE_RESTORER = Symbol("DATABASE_RESTORER");

export interface DatabaseRestoreStatus {
  running: boolean;
  label: string;
  done: boolean;
  success: boolean | null;
  errorMessage?: string;
  log: string;
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
