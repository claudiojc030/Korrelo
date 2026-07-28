import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type {
  ContainerOrchestrator,
  DeployConfig,
  TeardownConfig,
} from "../domain/container-orchestrator";
import { COMPOSE_FILENAME } from "../domain/container-orchestrator";

const execFile = promisify(execFileCallback);

@Injectable()
export class DockerComposeOrchestrator implements ContainerOrchestrator {
  async deploy(config: DeployConfig): Promise<void> {
    try {
      // execFile (não exec/shell): os argumentos vão direto pro processo, sem
      // passar por interpretação de shell — protege contra command injection
      // mesmo vindo de dados derivados do projeto (nome, path).
      await execFile(
        "docker",
        [
          "compose",
          "-f",
          COMPOSE_FILENAME,
          "-p",
          config.containerName,
          "up",
          "-d",
          "--build",
        ],
        { cwd: config.projectPath, timeout: 5 * 60 * 1000 },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(`Falha ao subir o container: ${message}`);
    }
  }

  async teardown(config: TeardownConfig): Promise<void> {
    await execFile(
      "docker",
      ["compose", "-f", COMPOSE_FILENAME, "-p", config.containerName, "down", "--remove-orphans"],
      { cwd: config.projectPath, timeout: 60 * 1000 },
    );
  }
}
