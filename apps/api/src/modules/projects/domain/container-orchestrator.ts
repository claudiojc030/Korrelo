export const CONTAINER_ORCHESTRATOR = Symbol("CONTAINER_ORCHESTRATOR");
export const COMPOSE_FILENAME = "docker-compose.korrelo.yml";
export const ENV_FILENAME = ".env.korrelo";

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
  // Tag da imagem candidata (ex.: "commit-abc123def456"). A tag default do
  // compose é essa; o rollback reusa o mesmo compose com outra tag.
  imageTag?: string;
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
  // servidor). NÃO mexe em volume nem em banco.
  rollback(config: DeployConfig, previousImage: string, action?: ProductionAction): Promise<string>;
  // Remove a instância de teste (sucesso ou falha, sempre no final).
  removeStaging(config: { projectPath: string; containerName: string }): Promise<void>;
  teardown(config: TeardownConfig): Promise<void>;
  // true quando o BuildKit está disponível (cache mounts e sintaxe moderna
  // de Dockerfile só funcionam com ele).
  supportsBuildKit(): Promise<boolean>;
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
