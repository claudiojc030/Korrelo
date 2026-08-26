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
  // Quando informados, o dump vai pra destDir/fileName em vez do caminho
  // padrão em exports/<projectId>.<ext> - usado pelo backup manual (ver
  // StartProjectBackupUseCase), que precisa do arquivo no mesmo formato de
  // pasta que o backup diário automático, pra cair na mesma listagem.
  destDir?: string;
  fileName?: string;
}

export interface DatabaseExporter {
  start(projectId: string, options: StartExportOptions): Promise<{ alreadyRunning: boolean }>;
  getStatus(projectId: string): Promise<DatabaseExportStatus>;
  getFilePath(projectId: string): Promise<string | null>;
}
