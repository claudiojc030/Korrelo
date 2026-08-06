export const CORE_ENV_REPOSITORY = Symbol("CORE_ENV_REPOSITORY");

export interface CoreEnvVar {
  key: string;
  value: string;
}

export interface CoreEnvRepository {
  list(): Promise<CoreEnvVar[]>;
  upsertOne(key: string, value: string): Promise<void>;
  upsertMany(values: Record<string, string>): Promise<void>;
}
