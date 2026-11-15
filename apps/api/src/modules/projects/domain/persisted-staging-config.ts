import type {
  StagingDependencyConfig,
  StagingProjectConfig,
  StagingResourceRequest,
} from "./staging-planner";

/**
 * P1B1 — PERSISTÊNCIA OPCIONAL DA CONFIGURAÇÃO DE STAGING.
 *
 * Nenhuma linha é criada automaticamente. Ausência de configuração = legado.
 * Não existe autorização por projeto nesta camada; o produto atual é
 * single-user/admin e nenhuma API é exposta nesta fase.
 */

export const STAGING_CONFIG_REPOSITORY = Symbol("STAGING_CONFIG_REPOSITORY");
export const STAGING_CONFIG_LOADER = Symbol("STAGING_CONFIG_LOADER");

export interface StagingConfigIssue {
  code: string;
  field: string;
  message: string;
}

export class StagingConfigValidationError extends Error {
  constructor(public readonly issues: StagingConfigIssue[]) {
    super(issues.map((issue) => issue.message).join("; ") || "Configuração de staging inválida.");
    this.name = "StagingConfigValidationError";
  }
}

export interface StagingSecretMetadata {
  id: string;
  key: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface StagingDependencyPersistenceInput {
  name: string;
  kind: string;
  mode?: "ephemeral" | "external" | "file";
  envKey?: string | null;
  target?: {
    scheme: string;
    host: string;
    port: number;
    database?: string | null;
  } | null;
  resources?: StagingResourceRequest | null;
  /** Chave do StagingSecret; nunca o valor. */
  externalSecretKey?: string | null;
  healthcheck?: string | null;
}

export interface StagingConfigPersistenceInput {
  mode: "isolated";
  ttlMinutes: number;
  allowEgress?: boolean;
  app: StagingResourceRequest;
  dependencies?: StagingDependencyPersistenceInput[];
  /** Valores em claro entram aqui apenas para serem cifrados pelo repositório. */
  secrets?: Array<{ key: string; value: string }>;
}

export interface PersistedStagingDependency {
  id: string;
  name: string;
  kind: string;
  mode: string;
  envKey: string | null;
  target: {
    scheme: string;
    host: string;
    port: number;
    database: string | null;
  } | null;
  resources: StagingResourceRequest | null;
  externalSecretId: string | null;
  healthcheck: string | null;
}

export interface PersistedStagingConfig {
  id: string;
  projectId: string;
  mode: string;
  ttlMinutes: number;
  allowEgress: boolean;
  app: StagingResourceRequest;
  dependencies: PersistedStagingDependency[];
  secrets: StagingSecretMetadata[];
}

export interface StagingConfigRepository {
  /**
   * Consulta COMUM: devolve configuração e METADADOS de segredos. Nunca
   * devolve valores secretos.
   */
  findByProjectId(projectId: string): Promise<PersistedStagingConfig | null>;
  /** Substituição interna completa; não é exposta por HTTP. */
  save(projectId: string, input: StagingConfigPersistenceInput): Promise<PersistedStagingConfig>;
  deleteByProjectId(projectId: string): Promise<void>;
  /** Leitura interna explícita, somente para montar fingerprint/execução futura. */
  resolveSecretValue(projectId: string, key: string): Promise<string | null>;
}

export interface StagingConfigLoadResult {
  ok: boolean;
  legacy: boolean;
  config: StagingProjectConfig | null;
  dependencies: StagingDependencyConfig[];
  issues: StagingConfigIssue[];
}

export interface StagingConfigLoader {
  load(projectId: string): Promise<StagingConfigLoadResult>;
}
