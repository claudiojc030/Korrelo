export const DATABASE_EXPORTER = Symbol("DATABASE_EXPORTER");

export interface DatabaseExportStatus {
  running: boolean;
  label: string;
  done: boolean;
  success: boolean | null;
  errorMessage?: string;
  log: string;
}

export interface StartExportOptions {
  containerName: string;
  dbType: "postgres" | "mongodb" | "redis";
  username: string | null;
  password: string | null;
  databaseName: string | null;
}

export interface DatabaseExporter {
  start(projectId: string, options: StartExportOptions): Promise<{ alreadyRunning: boolean }>;
  getStatus(projectId: string): Promise<DatabaseExportStatus>;
  getFilePath(projectId: string): Promise<string | null>;
}
