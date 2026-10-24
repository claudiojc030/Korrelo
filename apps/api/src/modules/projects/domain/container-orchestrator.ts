export const CONTAINER_ORCHESTRATOR = Symbol("CONTAINER_ORCHESTRATOR");
/**
 * Compose ESTÁVEL de produção.
 *
 * Só é publicado depois que a versão nova passou no health de produção.
 * Uma falha de staging nunca escreve aqui (ver DeployProjectUseCase).
 */
export const COMPOSE_FILENAME = "docker-compose.korrelo.yml";
/** Cópia da configuração de produção anterior, guardada antes de publicar a nova. */
export const COMPOSE_PREVIOUS_FILENAME = "docker-compose.korrelo.previous.yml";
/** Prefixo dos composes POR JOB (build/staging/promoção isolados). */
export const COMPOSE_JOB_PREFIX = "docker-compose.korrelo.job-";
export const ENV_FILENAME = ".env.korrelo";

/**
 * Nome do compose de um job de deploy.
 *
 * Cada tentativa usa o SEU arquivo: uma falha de staging não toca no compose
 * estável de produção. O jobId passa por um filtro conservador porque vira
 * nome de arquivo.
 */
export function jobComposeFilename(jobId: string): string {
  const safe = String(jobId || "unknown")
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .slice(0, 64);
  return `${COMPOSE_JOB_PREFIX}${safe}.yml`;
}

/** true para arquivos de compose por job (não são o compose estável). */
export function isJobComposeFilename(name: string): boolean {
  return name.startsWith(COMPOSE_JOB_PREFIX) && name.endsWith(".yml");
}

export interface DatabaseServiceConfig {
  type: "postgres" | "redis" | "mongodb";
  // Nome do serviço no compose (também o hostname que o app usa pra
  // conectar) - "db" pro primeiro banco do projeto, "db-<tipo>" pra
  // qualquer banco adicional. Ver ManagedDatabase.serviceName.
  serviceName: string;
  username: string;
  password: string;
  databaseName: string;
  memoryLimitMb: number;
  // Só relevante pro Redis. Postgres/MongoDB já são sempre persistentes.
  persistent: boolean;
}

export interface StagingServiceConfig {
  containerName: string;
  hostPort: number;
  /** Limite de memória do container de staging (temporário). */
  memoryLimitMb?: number;
}

/**
 * Healthcheck Docker do container.
 *
 * Configurável por projeto e CONSERVADOR por padrão: só é aplicado quando
 * o projeto define explicitamente (a pasta de settings). Não assumimos que
 * "/" significa saúde perfeita para qualquer stack, e o `startPeriodSeconds`
 * existe justamente pra não matar um app que só demora pra subir.
 */
export interface HealthcheckConfig {
  enabled: boolean;
  path: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  retries: number;
  startPeriodSeconds: number;
}

export interface DeployConfig {
  projectPath: string;
  containerName: string;
  hostPort: number;
  containerPort: number;
  memoryLimitMb: number;
  databases: DatabaseServiceConfig[];
  // Deploy sem downtime: builda e testa numa instância de teste (porta e
  // container à parte) ANTES de mexer na versão em produção. Ver
  // DeployProjectUseCase e deployStaging/promote abaixo.
  staging: StagingServiceConfig;
  // --- Wave 2 -------------------------------------------------------
  // Nome da imagem (sem tag) - a tag é a versão (commit).
  imageName?: string;
  // Tag da imagem DESTA operação (staging/promoção) ou, no rollback, a da
  // imagem anterior. NUNCA é usada como default no compose: o arquivo exige
  // `${KORRELO_IMAGE_TAG:?}` e o Korrelo passa a variável explicitamente.
  imageTag?: string;
  /**
   * Compose usado por ESTA operação (relativo ao projectPath ou absoluto).
   * Staging/promoção usam o arquivo do job; rollback usa o estável.
   * Default: COMPOSE_FILENAME (estável).
   */
  composeFilePath?: string;
  /**
   * Arquivo de ambiente CONTROLADO pelo Korrelo, usado só para interpolação
   * do compose (`--env-file`). Evita que um `.env` do repositório do projeto
   * defina `KORRELO_IMAGE_TAG` ou outras variáveis do compose.
   */
  composeEnvFilePath?: string;
  // Caminho ABSOLUTO do arquivo de ambiente do projeto. Fica FORA do
  // diretório do projeto de propósito: assim ele nunca entra no contexto de
  // build (e nem numa camada de imagem).
  envFilePath?: string;
  // Arquivo de ambiente EXCLUSIVO do staging (variáveis `KORRELO_STAGING_*`
  // com o prefixo removido). Só o serviço `app_staging` lê este arquivo.
  stagingEnvFilePath?: string | null;
  projectId?: string;
  deployJobId?: string;
  commitSha?: string | null;
  // Healthcheck Docker opcional (só quando o projeto configura).
  healthcheck?: HealthcheckConfig | null;
  // Teto de swap do container. null = não emitir (comportamento padrão do
  // Docker: o container pode usar swap até 2x o mem_limit).
  memswapLimitMb?: number | null;
}

export interface TeardownConfig {
  projectPath: string;
  containerName: string;
  // Só true na exclusão definitiva do projeto (DeleteProjectUseCase). No
  // rollback de um deploy que falhou (DeployProjectUseCase) fica false/undefined
  // de propósito, pra não apagar o volume do banco numa tentativa que pode ser
  // corrigida e reimplantada em seguida.
  removeVolumes?: boolean;
}

/**
 * Contexto obrigatório de qualquer operação que AFETE O CONTAINER DE
 * PRODUÇÃO (promover, fazer rollback).
 *
 * Sem ele, a operação é recusada: não existe caminho no código que recrie,
 * troque ou reverta o container de produção fora do fluxo normal de
 * DeployJob (Wave 2.1, Objetivo 10).
 */
export interface ProductionAction {
  /** Job de deploy que autorizou a operação. */
  deployJobId: string;
  /** Projeto dono do container. */
  projectId: string;
  /** Container alvo (tem que ser o de produção do projeto). */
  containerName: string;
  kind: "promote" | "rollback";
  /** Imagem anterior (obrigatória no rollback). */
  previousImage?: string | null;
}

/**
 * Estado observado do container de PRODUÇÃO (nunca inferido pelo banco).
 *
 * - `absent`: o Docker confirmou que o container não existe.
 * - `known`: container e referência de imagem verificados (o ID resolvido da
 *   referência bate com o ID da imagem que o container está usando).
 * - `unverified`: não foi possível COMPROVAR a identidade (Docker indisponível,
 *   referência solta, `sha256:...`, ID divergente). Nunca tratado como
 *   "produção intocada".
 */
export type ProductionContainerState =
  | { kind: "absent" }
  | { kind: "unverified"; containerId: string | null; reason: string }
  | { kind: "known"; containerId: string; imageReference: string; imageId: string };

export interface ContainerOrchestrator {
  // Builda e sobe SÓ a instância de teste (app_staging no compose), sem tocar
  // no container em produção (app) de jeito nenhum. Retorna stdout+stderr
  // combinados do docker compose, pro histórico de deploy mostrar o log real.
  deployStaging(config: DeployConfig): Promise<string>;
  // Só chamado depois que a instância de teste passou no health check. Recria
  // o serviço "app" de verdade reaproveitando a imagem já buildada (rápido,
  // não é um build novo) - esse é o único momento em que a versão em produção
  // é trocada.
  promote(config: DeployConfig, action?: ProductionAction): Promise<string>;
  // Rollback: volta a produção para a imagem anterior (que já está no
  // servidor). NÃO mexe em volume nem em banco. Deve ser chamado com
  // `config.composeFilePath` apontando para o compose ESTÁVEL (configuração
  // conhecida como boa) e uma `imageTag` explícita (a tag anterior).
  rollback(config: DeployConfig, previousImage: string, action?: ProductionAction): Promise<string>;
  // Remove a instância de teste (sucesso ou falha, sempre no final).
  removeStaging(config: { projectPath: string; containerName: string; composeFilePath?: string }): Promise<void>;
  teardown(config: TeardownConfig): Promise<void>;
  // true quando o BuildKit está disponível (cache mounts e sintaxe moderna
  // de Dockerfile só funcionam com ele).
  supportsBuildKit(): Promise<boolean>;
  // A imagem existe no servidor? Usado como PRÉ-REQUISITO de promoção: sem a
  // imagem atual em produção não existe alvo confiável de rollback.
  imageReferenceExists(reference: string): Promise<boolean>;
  /**
   * Inspeciona o container de produção para saber QUAL imagem ele realmente
   * executa. Usado para adoção segura de projetos legados e para detectar se
   * uma promoção alterou a produção antes de falhar.
   */
  inspectProductionContainer(containerName: string): Promise<ProductionContainerState>;
  // Remove imagens DO PROJETO que não estão protegidas. As imagens
  // protegidas (atual, anterior, candidata) nunca são removidas.
  pruneProjectImages(config: { imageName: string; protectedImages: string[] }): Promise<string>;
  /**
   * Limpa cache de build não utilizado (BuildKit) e imagens DANGLING.
   *
   * NUNCA remove imagem com tag `commit-*`, container, volume ou banco.
   * Não lança: devolve o resultado de cada comando (ok/erro) para o chamador
   * registrar. A reserva mínima de cache é mantida.
   */
  pruneUnusedBuildArtifacts(): Promise<BuildArtifactPruneResult>;
}

/** Resultado de um comando de limpeza (nunca lança por falha do Docker). */
export interface BuildArtifactPruneOutcome {
  ok: boolean;
  /** Saída combinada (truncada) quando o comando terminou. */
  output: string | null;
  error: string | null;
}

export interface BuildArtifactPruneResult {
  /** `docker image prune -f` - só camadas sem tag. */
  imagePrune: BuildArtifactPruneOutcome;
  /** `docker builder prune -f --reserved-space <reserva>`. */
  builderPrune: BuildArtifactPruneOutcome;
  /** Reserva mínima de cache preservada (ex.: "2GB"). */
  reservedSpace: string;
}
