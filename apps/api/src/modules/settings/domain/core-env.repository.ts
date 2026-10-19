export const CORE_ENV_REPOSITORY = Symbol("CORE_ENV_REPOSITORY");

export interface CoreEnvVar {
  key: string;
  value: string;
}

export interface CoreEnvRepository {
  list(): Promise<CoreEnvVar[]>;
  /** Lê o valor REAL de uma variável (sem máscara). Usado só na revelação
   *  explícita, protegida por senha. */
  getValue(key: string): Promise<string | null>;
  upsertOne(key: string, value: string): Promise<void>;
  upsertMany(values: Record<string, string>): Promise<void>;
}
