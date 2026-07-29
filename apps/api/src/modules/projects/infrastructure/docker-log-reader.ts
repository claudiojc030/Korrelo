import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { apiError } from "../../../infrastructure/api-error";
import type { LogReader } from "../domain/log-reader";

const execFile = promisify(execFileCallback);

// "docker logs" escreve stdout e stderr do container em streams separados; com
// --timestamps cada linha começa com um carimbo RFC3339, então dá pra intercalar
// as duas em ordem cronológica sem precisar de shell redirection (execFile puro).
function mergeByTimestamp(stdout: string, stderr: string): string {
  const lines = [...stdout.split("\n"), ...stderr.split("\n")].filter((line) => line.length > 0);
  lines.sort();
  return lines.join("\n");
}

@Injectable()
export class DockerLogReader implements LogReader {
  async readLogs(containerName: string, tailLines: number): Promise<string> {
    try {
      const { stdout, stderr } = await execFile(
        "docker",
        ["logs", "--timestamps", "--tail", String(tailLines), containerName],
        { timeout: 15_000, maxBuffer: 10 * 1024 * 1024 },
      );
      return mergeByTimestamp(stdout, stderr);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(apiError("LOG_READ_FAILED", `Falha ao ler logs de "${containerName}": ${message}`));
    }
  }
}
