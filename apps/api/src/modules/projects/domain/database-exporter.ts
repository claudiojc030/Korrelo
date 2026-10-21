export const DATABASE_EXPORTER = Symbol("DATABASE_EXPORTER");

export interface DatabaseExportStatus {
  running: boolean;
  label: string;
  done: boolean;
  success: boolean | null;
  errorMessage?: string;
  log: string;
  /** Bytes já escritos no arquivo de backup (dump em andamento). */
  bytesWritten?: number;
  /** Epoch ms do início do job. */
  startedAt?: number | null;
  /** Epoch ms da última atualização de progresso (heartbeat). */
  lastProgressAt?: number | null;
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
