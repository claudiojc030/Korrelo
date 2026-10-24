import { Injectable, InternalServerErrorException, Logger } from "@nestjs/common";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { apiError } from "../../../infrastructure/api-error";
import type {
  BuildArtifactPruneOutcome,
  BuildArtifactPruneResult,
  ContainerOrchestrator,
  DeployConfig,
  ProductionAction,
  ProductionContainerState,
  TeardownConfig,
} from "../domain/container-orchestrator";
import { COMPOSE_FILENAME } from "../domain/container-orchestrator";
import { SHARED_NETWORK } from "./docker-compose-file-builder";

const execFile = promisify(execFileCallback);

const PROMOTE_TIMEOUT_MS = 120_000;
/**
 * Reserva mínima de cache de build preservada entre deploys.
 *
 * O prune do BuildKit devolve o cache até este teto; abaixo disso o cache é
 * considerado útil e é mantido. Valor fixo de propósito: a reserva é parte da
 * garantia de que o próximo build não fica lento por falta de cache.
 */
export const BUILD_CACHE_RESERVE = "2GB";
/**
 * Timeout (ms) da subida + build do container de TESTE.
 *
 * Era 15min (900s). No Mesatta o build passou disso e foi morto durante
 * "Linting and checking validity of types ..." - não era erro de
 * compilação, era o limite. 30min dá folga pro build lento em VPS pequena
 * sem tornar o timeout infinito (o comando continua sendo abortado).
 *
 * Vale SÓ para o staging: promoção, remoção do staging e prune têm
 * constantes próprias abaixo e não são afetadas.
 */
const STAGING_TIMEOUT_MS = 30 * 60 * 1000;
const REMOVE_STAGING_TIMEOUT_MS = 30_000;
const PRUNE_TIMEOUT_MS = 60_000;
/**
 * Timeout do prune do BuildKit.
 *
 * Maior que o dos outros comandos de limpeza de propósito: remover vários GB
 * de cache numa VPS de 1 vCPU com I/O lento pode passar de 60s. Continua
 * FINITO - o worker nunca fica preso esperando a limpeza.
 */
const BUILD_CACHE_PRUNE_TIMEOUT_MS = 300_000;

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
  if (!name || !tag || tag.includes("/") || name.startsWith("sha256")) return null;
  return { name, tag };
}

/** Remove o prefixo `sha256:` para comparar IDs de imagem. */
function normalizeImageId(id: string): string {
  return id.trim().replace(/^sha256:/i, "").toLowerCase();
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
    // A tag NUNCA vem de default do compose nem de .env: é exigida aqui e
    // passada explicitamente (env vence .env do projeto e env do Core).
    const imageTag = this.requireImageTag(config, "staging");
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
      //
      // --no-deps: o staging NUNCA inicia (nem recria) as dependências do
      // projeto (o banco de produção). Sem isso, um "compose up" do staging
      // poderia subir/recriar o container do Mongo do Mesatta - o que
      // derrubaria a produção. Com --no-deps, o app de teste usa o banco
      // que JÁ está rodando (mesma rede).
      const build = await this.withLowPriority("docker", [
        "compose",
        ...this.composeFileArgs(config),
        "up",
        "-d",
        "--build",
        "--no-deps",
        "app_staging",
      ]);
      const { stdout, stderr } = await execFile(build.command, build.args, {
        // 30min: exportar a imagem pro storage do Docker pode ser lento numa
        // VPS pequena sob carga (I/O de disco) e o build inclui instalação de
        // dependências + lint/typecheck do projeto.
        cwd: config.projectPath,
        timeout: STAGING_TIMEOUT_MS,
        env: this.composeEnvironment(imageTag),
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
    const imageTag = this.requireImageTag(config, "promoção");
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
        ...this.composeFileArgs(config),
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
        env: this.composeEnvironment(imageTag),
      });
      output = combineOutput(stdout, stderr);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(
        apiError("CONTAINER_START_FAILED", `Falha ao trocar pra versão nova: ${message}\n${execOutputOf(error)}`),
      );
    }

    // A limpeza de cache/imagens dangling NÃO acontece mais aqui: ela roda no
    // `finally` do deploy (sucesso OU falha), depois de checar se há outra
    // operação crítica em andamento. Ver DeployProjectUseCase.cleanupBuildCache.
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
    // O compose do rollback tem o NOME da imagem do projeto. Se o projeto foi
    // renomeado, a tag antiga aponta para outro repositório e o rollback
    // silenciosamente não restauraria nada - melhor recusar explicitamente.
    if (config.imageName && parsed.name !== config.imageName) {
      throw new InternalServerErrorException(
        apiError(
          "ROLLBACK_IMAGE_MISMATCH",
          `A imagem anterior (${previousImage}) não pertence a este projeto (${config.imageName}) - rollback recusado.`,
        ),
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
          ...this.composeFileArgs(config),
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
          // A tag anterior vai EXPLÍCITA no env (vence .env do projeto e o
          // default inexistente do compose). O compose usado é o ESTÁVEL,
          // ou seja, a configuração conhecida como boa.
          env: this.composeEnvironment(parsed.tag),
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
   * Argumentos comuns de arquivo de compose.
   *
   * Staging/promoção usam o compose DO JOB; rollback usa o ESTÁVEL. Quando o
   * caller fornece um env-file controlado, ele SUBSTITUI o `.env` do
   * repositório do projeto na interpolação (defesa extra contra a tag ser
   * sobrescrita por um arquivo do projeto).
   */
  private composeFileArgs(config: DeployConfig): string[] {
    return [
      "-f",
      config.composeFilePath || COMPOSE_FILENAME,
      ...(config.composeEnvFilePath ? ["--env-file", config.composeEnvFilePath] : []),
      "-p",
      config.containerName,
    ];
  }

  /**
   * Tag obrigatória para qualquer operação que sobe container.
   *
   * Sem isso a operação é RECUSADA antes de qualquer comando no Docker (não
   * existe "usa a última que estava no arquivo").
   */
  private requireImageTag(config: DeployConfig, kind: string): string {
    const tag = (config.imageTag ?? "").trim();
    if (!tag) {
      throw new InternalServerErrorException(
        apiError(
          "COMPOSE_IMAGE_TAG_REQUIRED",
          `Operação de ${kind} recusada: KORRELO_IMAGE_TAG não foi definida pelo Korrelo.`,
        ),
      );
    }
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) {
      throw new InternalServerErrorException(
        apiError("COMPOSE_IMAGE_TAG_INVALID", `Tag de imagem inválida: "${tag}".`),
      );
    }
    return tag;
  }

  /**
   * Env do processo `docker compose`.
   *
   * `KORRELO_IMAGE_TAG` é SEMPRE sobrescrita aqui: nem o env do Core nem o
   * `.env` do projeto escolhem a imagem. O resto do env é herdado porque o
   * Docker precisa de DOCKER_HOST/PATH.
   */
  private composeEnvironment(imageTag: string): NodeJS.ProcessEnv {
    return { ...process.env, KORRELO_IMAGE_TAG: imageTag };
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

  async removeStaging(config: { projectPath: string; containerName: string; composeFilePath?: string }): Promise<void> {
    await execFile(
      "docker",
      [
        "compose",
        "-f",
        config.composeFilePath || COMPOSE_FILENAME,
        "-p",
        config.containerName,
        "rm",
        "-fs",
        "app_staging",
      ],
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

  /** A referência (tag) existe no servidor? Pré-requisito de promoção/rollback. */
  async imageReferenceExists(reference: string): Promise<boolean> {
    try {
      await execFile("docker", ["image", "inspect", reference], { timeout: 20_000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Inspeciona o container de produção e COMPROVA qual imagem ele executa.
   *
   * Regras de segurança:
   *  - container inexistente -> `absent` (é o único caso em que tratamos como
   *    "não há produção a preservar");
   *  - qualquer falha do Docker, referência sem tag, `sha256:...` ou ID que
   *    não bate -> `unverified`. Quem chama NUNCA deve assumir que a produção
   *    ficou intacta nesse estado.
   */
  async inspectProductionContainer(containerName: string): Promise<ProductionContainerState> {
    if (!containerName) {
      return { kind: "unverified", containerId: null, reason: "nome do container de produção vazio" };
    }

    let raw: string;
    try {
      const { stdout } = await execFile(
        "docker",
        ["inspect", "--format", "{{.Id}}|{{.Image}}|{{.Config.Image}}", containerName],
        { timeout: 20_000 },
      );
      raw = stdout.trim();
    } catch (error) {
      const output = execOutputOf(error);
      if (/no such (object|container)/i.test(output)) return { kind: "absent" };
      return {
        kind: "unverified",
        containerId: null,
        reason: output || (error instanceof Error ? error.message : String(error)),
      };
    }

    const [containerId, containerImageId, reference] = raw.split("|");
    if (!containerId || !containerImageId || !reference) {
      return {
        kind: "unverified",
        containerId: containerId || null,
        reason: "inspeção do container retornou dados incompletos",
      };
    }
    if (!splitImageReference(reference)) {
      return {
        kind: "unverified",
        containerId,
        reason: `referência "${reference}" não é repositório:tag`,
      };
    }

    let resolvedId: string;
    try {
      const { stdout } = await execFile(
        "docker",
        ["image", "inspect", "--format", "{{.Id}}", reference],
        { timeout: 20_000 },
      );
      resolvedId = stdout.trim();
    } catch (error) {
      return {
        kind: "unverified",
        containerId,
        reason: `referência "${reference}" não pôde ser verificada (${execOutputOf(error) || "imagem ausente"})`,
      };
    }

    if (normalizeImageId(resolvedId) !== normalizeImageId(containerImageId)) {
      return {
        kind: "unverified",
        containerId,
        reason: `referência "${reference}" não corresponde ao ID da imagem em execução`,
      };
    }

    return { kind: "known", containerId, imageReference: reference, imageId: containerImageId };
  }

  /**
   * Cada rebuild (`--build`) deixa pra trás a camada de cache antiga e, se o
   * Dockerfile mudou, a imagem `<none>` anterior com a mesma tag. Nenhum dos
   * dois é usado pelo container que acabou de subir.
   *
   * Roda no `finally` do deploy (sucesso OU falha) e é o ÚNICO lugar que faz
   * isso - não é chamada por `promote()`.
   *
   * SEGURANÇA:
   * - `docker image prune -f` remove SÓ camadas sem tag (dangling). Imagens
   *   com tag `commit-*`, current/previous/candidata e as usadas por container
   *   NÃO são tocadas;
   * - `docker builder prune` mexe só no cache do BuildKit, preservando a
   *   reserva (`BUILD_CACHE_RESERVE`);
   * - nunca usa `-a`, `--rmi`, `volume prune` ou `system prune`.
   *
   * NÃO lança: devolve o resultado de cada comando para quem chama registrar.
   */
  async pruneUnusedBuildArtifacts(): Promise<BuildArtifactPruneResult> {
    const run = async (args: string[], timeoutMs: number): Promise<BuildArtifactPruneOutcome> => {
      try {
        const { stdout, stderr } = await execFile("docker", args, { timeout: timeoutMs });
        return {
          ok: true,
          output: combineOutput(stdout, stderr).slice(0, 500) || null,
          error: null,
        };
      } catch (error) {
        return {
          ok: false,
          output: execOutputOf(error).slice(0, 500) || null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    };

    // Sem --keep-storage, "docker builder prune -f" só remove cache que o
    // BuildKit já considera 100% sem referência - numa VPS que só faz deploy
    // sequencial (nunca dois builds em paralelo), a cadeia de camadas antigas
    // fica presa como "em uso" e o cache cresce sem limite. A reserva força um
    // teto real. --keep-storage foi renomeado para --reserved-space nas
    // versões mais novas do Docker (a flag antiga é aceita mas ignorada com
    // aviso de "deprecated", sem limitar nada).
    const imagePrune = await run(["image", "prune", "-f"], PRUNE_TIMEOUT_MS);
    const builderPrune = await run(
      ["builder", "prune", "-f", "--reserved-space", BUILD_CACHE_RESERVE],
      BUILD_CACHE_PRUNE_TIMEOUT_MS,
    );

    if (!imagePrune.ok) {
      this.logger.warn(`Falha ao limpar imagens dangling: ${imagePrune.error}`);
    }
    if (!builderPrune.ok) {
      this.logger.warn(`Falha ao limpar cache de build: ${builderPrune.error}`);
    }

    return { imagePrune, builderPrune, reservedSpace: BUILD_CACHE_RESERVE };
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
