export const LOG_READER = Symbol("LOG_READER");

export interface LogReader {
  readLogs(containerName: string, tailLines: number): Promise<string>;
}
