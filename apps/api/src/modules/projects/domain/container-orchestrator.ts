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

export interface DeployConfig {
  projectPath: string;
  containerName: string;
  hostPort: number;
  containerPort: number;
  memoryLimitMb: number;
  database?: DatabaseServiceConfig;
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
  deploy(config: DeployConfig): Promise<void>;
  teardown(config: TeardownConfig): Promise<void>;
}
