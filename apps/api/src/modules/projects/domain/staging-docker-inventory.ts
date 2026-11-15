/**
 * P1B2 — INVENTÁRIO DOCKER SOMENTE LEITURA.
 *
 * Não lê Config.Env, não inspeciona segredos e não executa operações
 * destrutivas. `complete=false` impede qualquer decisão de liberar recursos.
 */
export const STAGING_DOCKER_INVENTORY = Symbol("STAGING_DOCKER_INVENTORY");

export interface DockerContainerInventory {
  id: string;
  name: string;
  state: string | null;
  image: string | null;
  labels: Record<string, string>;
  publishedPorts: number[];
  composeProject: string | null;
}

export interface DockerNetworkInventory {
  name: string;
  labels: Record<string, string>;
}

export interface DockerVolumeInventory {
  name: string;
  labels: Record<string, string>;
}

export interface StagingDockerInventorySnapshot {
  complete: boolean;
  containers: DockerContainerInventory[];
  networks: DockerNetworkInventory[];
  volumes: DockerVolumeInventory[];
  publishedPorts: number[];
  error: string | null;
}

export interface StagingDockerInventoryReader {
  inspect(): Promise<StagingDockerInventorySnapshot>;
}
