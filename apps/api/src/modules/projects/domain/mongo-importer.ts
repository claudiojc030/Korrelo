export const MONGO_IMPORTER = Symbol("MONGO_IMPORTER");

export interface MongoImportStatus {
  running: boolean;
  percent: number;
  label: string;
  done: boolean;
  success: boolean | null;
  errorMessage?: string;
  log: string;
}

export interface MongoImporter {
  start(projectId: string, containerName: string, sourceUri: string, targetUri: string): Promise<{ alreadyRunning: boolean }>;
  getStatus(projectId: string): Promise<MongoImportStatus>;
}
