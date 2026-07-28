import type { EnvVar } from "./env-var.entity";

export const ENV_VAR_REPOSITORY = Symbol("ENV_VAR_REPOSITORY");

export interface EnvVarInput {
  key: string;
  value: string;
}

export interface EnvVarRepository {
  findByProjectId(projectId: string): Promise<EnvVar[]>;
  replaceAll(projectId: string, vars: EnvVarInput[]): Promise<EnvVar[]>;
  upsertOne(projectId: string, input: EnvVarInput): Promise<void>;
}
