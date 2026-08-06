import { Injectable, InternalServerErrorException, Logger } from "@nestjs/common";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { apiError } from "../../../infrastructure/api-error";
import type {
  ContainerOrchestrator,
  DeployConfig,
  TeardownConfig,
} from "../domain/container-orchestrator";
import { COMPOSE_FILENAME } from "../domain/container-orchestrator";

const execFile = promisify(execFileCallback);

function combineOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

// execFile rejeita com um erro que carrega .stdout/.stderr do processo, mas
// o próprio Error.message só traz "Command failed" - sem isso o log do
// deploy perde justamente o output que interessa numa falha.
function execOutputOf(error: unknown): string {
  if (error && typeof error === "object" && "stdout" in error) {
    return combineOutput(String((error as { stdout?: string }).stdout ?? ""), String((error as { stderr?: string }).stderr ?? ""));
  }
  return "";
}

@Injectable()
export class DockerComposeOrchestrator implements ContainerOrchestrator {
  private readonly logger = new Logger(DockerComposeOrchestrator.name);

  async deployStaging(config: DeployConfig): Promise<string> {
    try {
      // execFile (não exec/shell): os argumentos vão direto pro processo, sem
      // passar por interpretação de shell. Isso protege contra command injection
      // mesmo vindo de dados derivados do projeto (nome, path). Só builda e sobe
      // "app_staging" - a versão em produção ("app") nem é tocada aqui.
      const { stdout, stderr } = await execFile(
        "docker",
        ["compose", "-f", COMPOSE_FILENAME, "-p", config.containerName, "up", "-d", "--build", "app_staging"],
        // 15min: exportar a imagem pro storage do Docker pode ser lento numa
        // VPS pequena sob carga (I/O de disco), 5min matava builds legítimos.
        { cwd: config.projectPath, timeout: 15 * 60 * 1000 },
      );
      return combineOutput(stdout, stderr);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(
        apiError("CONTAINER_START_FAILED", `Falha ao subir o container de teste: ${message}\n${execOutputOf(error)}`),
      );
    }
  }

  async promote(config: DeployConfig): Promise<string> {
    let output: string;
    try {
      // --no-deps: não mexe no "db" (já está rodando). --build aqui é rápido,
      // a imagem já foi buildada no deployStaging e fica em cache. Esse é o
      // único momento em que a versão em produção troca, então é a única
      // janela de indisponibilidade real (poucos segundos, não o build inteiro).
      const { stdout, stderr } = await execFile(
        "docker",
        ["compose", "-f", COMPOSE_FILENAME, "-p", config.containerName, "up", "-d", "--build", "--no-deps", "app"],
        { cwd: config.projectPath, timeout: 60 * 1000 },
      );
      output = combineOutput(stdout, stderr);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(
        apiError("CONTAINER_START_FAILED", `Falha ao trocar pra versão nova: ${message}\n${execOutputOf(error)}`),
      );
    }

    await this.pruneUnusedBuildArtifacts();
    return output;
  }

  async removeStaging(config: { projectPath: string; containerName: string }): Promise<void> {
    await execFile(
      "docker",
      ["compose", "-f", COMPOSE_FILENAME, "-p", config.containerName, "rm", "-fs", "app_staging"],
      { cwd: config.projectPath, timeout: 30_000 },
    );
  }

  // Cada rebuild (`--build`) deixa pra trás a camada de build cache antiga e,
  // se o Dockerfile mudou, a imagem <none> anterior com a mesma tag. Nenhum
  // dos dois é usado pelo container que acabou de subir, então dá pra limpar
  // sempre, sem risco de derrubar algo em uso (docker nunca remove imagem
  // referenciada por container rodando, mesmo com -f). Roda depois de CADA
  // deploy (Korrelo continua reaproveitando o cache de builds recentes,
  // já que -f não é "-a": só o que virou lixo desde então).
  private async pruneUnusedBuildArtifacts(): Promise<void> {
    try {
      await execFile("docker", ["image", "prune", "-f"], { timeout: 60 * 1000 });
      await execFile("docker", ["builder", "prune", "-f"], { timeout: 60 * 1000 });
    } catch (error) {
      this.logger.warn(`Falha ao limpar imagens/cache de build não usados: ${error}`);
    }
  }

  async teardown(config: TeardownConfig): Promise<void> {
    const args = ["compose", "-f", COMPOSE_FILENAME, "-p", config.containerName, "down", "--remove-orphans"];
    if (config.removeVolumes) {
      // -v apaga o volume do banco (dado do projeto); --rmi local só remove a
      // imagem buildada pra ESTE projeto (não mexe em imagens baixadas como
      // postgres/redis/mongo, que podem ser reaproveitadas por outros).
      args.push("-v", "--rmi", "local");
    }
    await execFile("docker", args, { cwd: config.projectPath, timeout: 60 * 1000 });
  }
}
