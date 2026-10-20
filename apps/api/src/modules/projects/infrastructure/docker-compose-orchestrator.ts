import { Injectable, InternalServerErrorException, Logger } from "@nestjs/common";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { apiError } from "../../../infrastructure/api-error";
import type {
  ContainerOrchestrator,
  DeployConfig,
  ProductionAction,
  TeardownConfig,
} from "../domain/container-orchestrator";
import { COMPOSE_FILENAME } from "../domain/container-orchestrator";
import { SHARED_NETWORK } from "./docker-compose-file-builder";

const execFile = promisify(execFileCallback);

const PROMOTE_TIMEOUT_MS = 120_000;
const STAGING_TIMEOUT_MS = 15 * 60 * 1000;
const REMOVE_STAGING_TIMEOUT_MS = 30_000;
const PRUNE_TIMEOUT_MS = 60_000;

/**
 * Quantas imagens VERSINADAS do projeto são mantidas além da atual e da
 * anterior. As imagens são tagueadas por commit, então o prune seguro é
 * explícito (remove por TAG, nunca "docker system prune -a").
 */
const IMAGE_RETENTION = 3;

function combineOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

// execFile rejeita com um erro que carrega .stdout/.stderr do processo, mas
// o próprio Error.message só traz "Command failed" - sem isso o log do
// deploy perde justamente o output que interessa numa falha.
function execOutputOf(error: unknown): string {
  if (error && typeof error === "object" && "stdout" in error) {
    return combineOutput(
      String((error as { stdout?: string }).stdout ?? ""),
      String((error as { stderr?: string }).stderr ?? ""),
    );
  }
  return "";
}

/** "korrelo-x-123:commit-abc" -> { name: "korrelo-x-123", tag: "commit-abc" } */
export function splitImageReference(reference: string): { name: string; tag: string } | null {
  const index = reference.lastIndexOf(":");
  if (index <= 0) return null;
  const name = reference.slice(0, index);
  const tag = reference.slice(index + 1);
  if (!name || !tag || tag.includes("/")) return null;
  return { name, tag };
}

/**
 * PRIORIDADE DO BUILD.
 *
 * O build de um projeto roda na MESMA VPS que serve a produção. O processo
 * do `docker compose` (e o que ele faz no host) roda com prioridade
 * baixa: `ionice -c 3` (classe de I/O ociosa) + `nice -n 10`.
 *
 * Observação honesta: o trabalho PESADO do build acontece dentro do daemon
 * do Docker (BuildKit), que NÃO é filho deste processo - então nice/ionice
 * não limitam o daemon. O que de fato protege a produção é o resource
 * guard (não iniciar build com o host carregado) + o limite de memória do
 * build gerado no Dockerfile. O nice/ionice aqui reduz o impacto do
 * trabalho do CLI e de qualquer passo local do compose.
 */
const BUILD_NICE_LEVEL = 10;

@Injectable()
export class DockerComposeOrchestrator implements ContainerOrchestrator {
  private readonly logger = new Logger(DockerComposeOrchestrator.name);
  private buildKitSupport: boolean | null = null;
  private priorityTools: { nice: boolean; ionice: boolean } | null = null;

  /** Detecta (uma vez) se `nice`/`ionice` existem no host. */
  private async detectPriorityTools(): Promise<{ nice: boolean; ionice: boolean }> {
    if (this.priorityTools) return this.priorityTools;
    const probe = async (command: string, args: string[]): Promise<boolean> => {
      try {
        await execFile(command, args, { timeout: 5_000 });
        return true;
      } catch {
        return false;
      }
    };
    this.priorityTools = {
      nice: await probe("nice", ["--version"]),
      ionice: await probe("ionice", ["-c", "3", "true"]),
    };
    return this.priorityTools;
  }

  /** Envolve o comando com nice/ionice (se existirem). */
  private async withLowPriority(
    command: string,
    args: string[],
  ): Promise<{ command: string; args: string[] }> {
    const tools = await this.detectPriorityTools();
    let finalCommand = command;
    let finalArgs = [...args];
    if (tools.ionice) {
      finalArgs = ["-c", "3", finalCommand, ...finalArgs];
      finalCommand = "ionice";
    }
    if (tools.nice) {
      finalArgs = ["-n", String(BUILD_NICE_LEVEL), finalCommand, ...finalArgs];
      finalCommand = "nice";
    }
    return { command: finalCommand, args: finalArgs };
  }

  // A rede é "external: true" no compose de todo projeto (ver
  // docker-compose-file-builder.ts) - se ela não existir ainda no host, o
  // primeiro "docker compose up" de qualquer projeto falha com "network
  // korrelo-shared declared as external, but could not be found". Idempotente:
  // ignora o erro de "já existe" numa corrida entre deploys simultâneos.
  private async ensureSharedNetwork(): Promise<void> {
    try {
      await execFile("docker", ["network", "create", SHARED_NETWORK], { timeout: 15_000 });
    } catch (error) {
      const message = execOutputOf(error) || (error instanceof Error ? error.message : String(error));
      if (!message.includes("already exists")) {
        this.logger.warn(`Falha ao garantir a rede compartilhada "${SHARED_NETWORK}": ${message}`);
      }
    }
  }

  async deployStaging(config: DeployConfig): Promise<string> {
    await this.ensureSharedNetwork();
    try {
      // execFile (não exec/shell): os argumentos vão direto pro processo, sem
      // passar por interpretação de shell. Isso protege contra command injection
      // mesmo vindo de dados derivados do projeto (nome, path). Só builda e sobe
      // "app_staging" - a versão em produção ("app") nem é tocada aqui.
      //
      // A imagem gerada é TAGUEADA por commit (ver imageTag no compose), o
      // que permite promover sem rebuild e fazer rollback pra uma versão
      // anterior concreta.
      // Prioridade baixa: o build não disputa I/O/CPU com a produção.
      const build = await this.withLowPriority("docker", [
        "compose",
        "-f",
        COMPOSE_FILENAME,
        "-p",
        config.containerName,
        "up",
        "-d",
        "--build",
        "app_staging",
      ]);
      const { stdout, stderr } = await execFile(build.command, build.args, {
        // 15min: exportar a imagem pro storage do Docker pode ser lento numa
        // VPS pequena sob carga (I/O de disco), 5min matava builds legítimos.
        cwd: config.projectPath,
        timeout: STAGING_TIMEOUT_MS,
      });
      return combineOutput(stdout, stderr);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(
        apiError("CONTAINER_START_FAILED", `Falha ao subir o container de teste: ${message}\n${execOutputOf(error)}`),
      );
    }
  }

  async promote(config: DeployConfig, action?: ProductionAction): Promise<string> {
    this.assertProductionAction(action, config, "promote");
    let output: string;
    try {
      // --no-deps: não mexe no "db" (já está rodando).
      // A imagem JÁ FOI BUILDADA no deployStaging (mesma tag) - reconstruir
      // aqui seria um segundo build (minutos de CPU/RAM) e ainda poderia
      // falhar por timeout, derrubando a produção no meio. Só rebuilda se a
      // imagem não existir (deploy sem staging, por exemplo).
      const imageExists = await this.imageExists(config);
      const args = [
        "compose",
        "-f",
        COMPOSE_FILENAME,
        "-p",
        config.containerName,
        "up",
        "-d",
        ...(imageExists ? ["--no-build"] : ["--build"]),
        "--force-recreate",
        "--no-deps",
        "app",
      ];
      const { stdout, stderr } = await execFile("docker", args, {
        cwd: config.projectPath,
        timeout: PROMOTE_TIMEOUT_MS,
      });
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

  /**
   * ROLLBACK: volta a produção para a imagem anterior.
   *
   * - NÃO mexe em volume, banco nem dados (rollback é de APLICAÇÃO).
   * - Reusa o mesmo compose com KORRELO_IMAGE_TAG apontando pra tag
   *   anterior: o container de produção é recriado com a imagem antiga.
   * - Se a imagem anterior não existir mais, o erro é explícito (não há
   *   versão anterior pra voltar).
   */
  async rollback(config: DeployConfig, previousImage: string, action?: ProductionAction): Promise<string> {
    this.assertProductionAction(action, config, "rollback", previousImage);
    const parsed = splitImageReference(previousImage);
    if (!parsed) {
      throw new InternalServerErrorException(
        apiError("ROLLBACK_IMAGE_INVALID", `Imagem anterior inválida: "${previousImage}".`),
      );
    }

    const exists = await this.imageReferenceExists(previousImage);
    if (!exists) {
      throw new InternalServerErrorException(
        apiError(
          "ROLLBACK_IMAGE_MISSING",
          `A imagem anterior (${previousImage}) não está mais no servidor - rollback manual necessário.`,
        ),
      );
    }

    try {
      const { stdout, stderr } = await execFile(
        "docker",
        [
          "compose",
          "-f",
          COMPOSE_FILENAME,
          "-p",
          config.containerName,
          "up",
          "-d",
          "--no-build",
          "--force-recreate",
          "--no-deps",
          "app",
        ],
        {
          cwd: config.projectPath,
          timeout: PROMOTE_TIMEOUT_MS,
          // O compose usa ${KORRELO_IMAGE_TAG:-<tag do deploy>} na linha
          // "image:" - sobrescrevendo a variável, a promoção roda com a
          // imagem anterior.
          env: { ...process.env, KORRELO_IMAGE_TAG: parsed.tag },
        },
      );
      return combineOutput(stdout, stderr);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(
        apiError("ROLLBACK_FAILED", `Falha ao voltar pra imagem anterior: ${message}\n${execOutputOf(error)}`),
      );
    }
  }

  /**
   * GUARDA DE PRODUÇÃO (Wave 2.1, Objetivo 10).
   *
   * Nenhuma operação que afete o container de PRODUÇÃO acontece sem passar
   * por um DeployJob com o contexto completo (job, projeto e container
   * alvo). Sem isso, a operação é recusada - não existe caminho no código que
   * recrie/troque/reverta produção fora do fluxo de deploy.
   */
  private assertProductionAction(
    action: ProductionAction | undefined,
    config: DeployConfig,
    kind: "promote" | "rollback",
    previousImage?: string,
  ): void {
    if (!action) {
      throw new InternalServerErrorException(
        apiError(
          "PRODUCTION_ACTION_UNGUARDED",
          `Operação de produção ("${kind}") recusada: nenhuma referência de job de deploy foi informada.`,
        ),
      );
    }
    if (!action.deployJobId) {
      throw new InternalServerErrorException(
        apiError("PRODUCTION_ACTION_UNGUARDED", `Operação de produção ("${kind}") recusada: job de deploy inválido.`),
      );
    }
    if (!action.projectId) {
      throw new InternalServerErrorException(
        apiError("PRODUCTION_ACTION_UNGUARDED", `Operação de produção ("${kind}") recusada: projeto inválido.`),
      );
    }
    if (action.containerName !== config.containerName) {
      throw new InternalServerErrorException(
        apiError(
          "PRODUCTION_TARGET_MISMATCH",
          `Operação de produção ("${kind}") recusada: o container alvo (${action.containerName}) não é o de produção do projeto (${config.containerName}).`,
        ),
      );
    }
    if (kind === "rollback" && !previousImage) {
      throw new InternalServerErrorException(
        apiError("PRODUCTION_ACTION_UNGUARDED", "Rollback recusado: não há imagem anterior registrada."),
      );
    }
  }

  async removeStaging(config: { projectPath: string; containerName: string }): Promise<void> {
    await execFile(
      "docker",
      ["compose", "-f", COMPOSE_FILENAME, "-p", config.containerName, "rm", "-fs", "app_staging"],
      { cwd: config.projectPath, timeout: REMOVE_STAGING_TIMEOUT_MS },
    );
  }

  /**
   * Remove imagens VERSINADAS do projeto que não estão protegidas.
   *
   * NUNCA usa "docker system prune -a" (apagaria imagem de outro projeto, de
   * outro uso da VPS). Só remove tags deste projeto, e nunca as protegidas
   * (atual, anterior e candidata).
   */
  async pruneProjectImages(config: { imageName: string; protectedImages: string[] }): Promise<string> {
    const protectedSet = new Set(config.protectedImages.filter(Boolean));
    try {
      const { stdout } = await execFile(
        "docker",
        ["images", "--filter", `reference=${config.imageName}`, "--format", "{{.Repository}}:{{.Tag}}\t{{.CreatedAt}}"],
        { timeout: PRUNE_TIMEOUT_MS },
      );

      const entries = stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [reference, createdAt] = line.split("\t");
          return { reference, createdAt: createdAt ? Date.parse(createdAt) || 0 : 0 };
        })
        .filter((entry) => entry.reference && entry.reference !== "<none>:<none>");

      const removable = entries
        .filter((entry) => !protectedSet.has(entry.reference))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(IMAGE_RETENTION);

      const removed: string[] = [];
      for (const entry of removable) {
        try {
          await execFile("docker", ["rmi", entry.reference], { timeout: PRUNE_TIMEOUT_MS });
          removed.push(entry.reference);
        } catch {
          // Imagem em uso por container rodando (o Docker recusa) - deixa pra
          // próxima limpeza.
        }
      }
      return removed.join(", ");
    } catch (error) {
      this.logger.warn(`Falha ao limpar imagens antigas do projeto: ${(error as Error).message}`);
      return "";
    }
  }

  /**
   * O BuildKit está disponível? (cache mount e sintaxe moderna de Dockerfile
   * só funcionam com ele; sem ele, o gerador usa o Dockerfile "clássico".)
   */
  async supportsBuildKit(): Promise<boolean> {
    if (this.buildKitSupport !== null) return this.buildKitSupport;
    try {
      await execFile("docker", ["buildx", "version"], { timeout: 10_000 });
      this.buildKitSupport = true;
    } catch {
      this.buildKitSupport = false;
    }
    return this.buildKitSupport;
  }

  private async imageExists(config: DeployConfig): Promise<boolean> {
    if (!config.imageName || !config.imageTag) return false;
    return this.imageReferenceExists(`${config.imageName}:${config.imageTag}`);
  }

  private async imageReferenceExists(reference: string): Promise<boolean> {
    try {
      await execFile("docker", ["image", "inspect", reference], { timeout: 20_000 });
      return true;
    } catch {
      return false;
    }
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
      await execFile("docker", ["image", "prune", "-f"], { timeout: PRUNE_TIMEOUT_MS });
      // Sem --keep-storage, "docker builder prune -f" só remove cache que o
      // BuildKit já considera 100% sem referência - numa VPS que só faz
      // deploy sequencial (nunca dois builds em paralelo), a cadeia de
      // camadas de builds antigos fica presa como "em uso" indefinidamente,
      // e o cache cresce sem limite (visto em produção: 12GB+ de build cache,
      // boa parte do disco da VPS). --keep-storage força um teto real,
      // descartando as entradas mais antigas quando passa disso.
      // --keep-storage foi renomeado pra --reserved-space em versões mais
      // novas do Docker (visto em produção: a flag antiga é aceita mas
      // ignorada com um aviso de "deprecated", sem realmente limitar nada).
      await execFile("docker", ["builder", "prune", "-f", "--reserved-space", "2GB"], { timeout: PRUNE_TIMEOUT_MS });
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
    await execFile("docker", args, { cwd: config.projectPath, timeout: PRUNE_TIMEOUT_MS });
  }
}
