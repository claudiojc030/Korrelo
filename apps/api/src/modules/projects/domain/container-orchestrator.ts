export const CONTAINER_ORCHESTRATOR = Symbol("CONTAINER_ORCHESTRATOR");
export const COMPOSE_FILENAME = "docker-compose.forgedesk.yml";
export const ENV_FILENAME = ".env.forgedesk";

export interface DeployConfig {
  projectPath: string;
  containerName: string;
  hostPort: number;
  containerPort: number;
  memoryLimitMb: number;
}

export interface TeardownConfig {
  projectPath: string;
  containerName: string;
}

export interface ContainerOrchestrator {
  deploy(config: DeployConfig): Promise<void>;
  teardown(config: TeardownConfig): Promise<void>;
}
