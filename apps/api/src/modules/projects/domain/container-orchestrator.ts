export const CONTAINER_ORCHESTRATOR = Symbol("CONTAINER_ORCHESTRATOR");
export const COMPOSE_FILENAME = "docker-compose.forgedesk.yml";
export const ENV_FILENAME = ".env.forgedesk";

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
}

export interface ContainerOrchestrator {
  deploy(config: DeployConfig): Promise<void>;
  teardown(config: TeardownConfig): Promise<void>;
}
