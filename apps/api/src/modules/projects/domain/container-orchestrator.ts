export const CONTAINER_ORCHESTRATOR = Symbol("CONTAINER_ORCHESTRATOR");
export const COMPOSE_FILENAME = "docker-compose.korrelo.yml";
export const ENV_FILENAME = ".env.korrelo";

export interface DatabaseServiceConfig {
  type: "postgres" | "redis" | "mongodb";
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
}

export interface DeployConfig {
  projectPath: string;
  containerName: string;
  hostPort: number;
  containerPort: number;
  memoryLimitMb: number;
  database?: DatabaseServiceConfig;
  // Deploy sem downtime: builda e testa numa instância de teste (porta e
  // container à parte) ANTES de mexer na versão em produção. Ver
  // DeployProjectUseCase e deployStaging/promote abaixo.
  staging: StagingServiceConfig;
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

export interface ContainerOrchestrator {
  // Builda e sobe SÓ a instância de teste (app_staging no compose), sem tocar
  // no container em produção (app) de jeito nenhum.
  deployStaging(config: DeployConfig): Promise<void>;
  // Só chamado depois que a instância de teste passou no health check. Recria
  // o serviço "app" de verdade reaproveitando a imagem já buildada (rápido,
  // não é um build novo) - esse é o único momento em que a versão em produção
  // é trocada.
  promote(config: DeployConfig): Promise<void>;
  // Remove a instância de teste (sucesso ou falha, sempre no final).
  removeStaging(config: { projectPath: string; containerName: string }): Promise<void>;
  teardown(config: TeardownConfig): Promise<void>;
}
