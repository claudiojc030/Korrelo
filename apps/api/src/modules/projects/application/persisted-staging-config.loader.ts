import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import {
  STAGING_CONFIG_REPOSITORY,
  type PersistedStagingConfig,
  type StagingConfigIssue,
  type StagingConfigLoader,
  type StagingConfigLoadResult,
  type StagingConfigRepository,
} from "../domain/persisted-staging-config";
import type {
  StagingDependencyConfig,
  StagingProjectConfig,
} from "../domain/staging-planner";

/**
 * Adaptador INTERNO que traduz a configuração persistida para o formato do P0.
 *
 * - não é exposto por HTTP;
 * - valores de segredo nunca entram no resultado;
 * - fingerprints de segredo externo são calculados em memória apenas para a
 *   checagem de reutilização do P0 e não são persistidos nem retornados pela
 *   API;
 * - ausência de configuração = legado.
 */
@Injectable()
export class PersistedStagingConfigLoader implements StagingConfigLoader {
  constructor(
    @Inject(STAGING_CONFIG_REPOSITORY) private readonly repository: StagingConfigRepository,
  ) {}

  async load(projectId: string): Promise<StagingConfigLoadResult> {
    let record: PersistedStagingConfig | null;
    try {
      record = await this.repository.findByProjectId(projectId);
    } catch {
      return {
        ok: false,
        legacy: false,
        config: null,
        dependencies: [],
        issues: [
          {
            code: "STAGING_CONFIG_UNAVAILABLE",
            field: "config",
            message: "Não foi possível ler a configuração persistida; dry-run recusado.",
          },
        ],
      };
    }

    if (!record) {
      return { ok: true, legacy: true, config: null, dependencies: [], issues: [] };
    }

    const issues: StagingConfigIssue[] = [];
    if (record.mode !== "isolated") {
      issues.push({
        code: "STAGING_CONFIG_INVALID",
        field: "mode",
        message: `Modo de staging persistido inválido: "${record.mode}".`,
      });
    }

    const dependencyEnvKeys = new Set(
      record.dependencies
        .map((dependency) => dependency.envKey)
        .filter((key): key is string => typeof key === "string" && key.length > 0),
    );
    const dependencySecretIds = new Set(
      record.dependencies
        .map((dependency) => dependency.externalSecretId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );
    const dependencySecretKeys = new Set(
      record.secrets
        .filter((secret) => dependencySecretIds.has(secret.id))
        .map((secret) => secret.key),
    );
    const env: StagingProjectConfig["env"] = record.secrets
      .filter((secret) => !dependencyEnvKeys.has(secret.key) && !dependencySecretKeys.has(secret.key))
      .map((secret) => ({ key: secret.key, source: "explicit" as const }));

    const dependencies: StagingDependencyConfig[] = [];
    for (const dependency of record.dependencies) {
      const mapped: StagingDependencyConfig = {
        name: dependency.name,
        kind: dependency.kind,
        projectId,
        mode: dependency.mode as StagingDependencyConfig["mode"],
        envKey: dependency.envKey ?? undefined,
        resources: dependency.resources ?? undefined,
        target: dependency.target ?? undefined,
        healthcheck: dependency.healthcheck ?? undefined,
      };

      if (dependency.kind === "external") {
        if (!dependency.externalSecretId) {
          issues.push({
            code: "STAGING_CONFIG_INCOMPLETE",
            field: `dependencies.${dependency.name}.externalSecret`,
            message: `Dependência externa "${dependency.name}" não tem segredo de staging.`,
          });
        } else {
          const metadata = record.secrets.find((secret) => secret.id === dependency.externalSecretId);
          if (!metadata) {
            issues.push({
              code: "STAGING_CONFIG_INCOMPLETE",
              field: `dependencies.${dependency.name}.externalSecret`,
              message: `Segredo da dependência externa "${dependency.name}" não encontrado.`,
            });
          } else {
            try {
              const value = await this.repository.resolveSecretValue(projectId, metadata.key);
              if (value === null) {
                issues.push({
                  code: "STAGING_CONFIG_INCOMPLETE",
                  field: `dependencies.${dependency.name}.externalSecret`,
                  message: `Segredo da dependência externa "${dependency.name}" não pôde ser lido.`,
                });
              } else {
                // Fingerprint em memória, nunca persistido/retornado por API.
                mapped.secretFingerprint = createHash("sha256").update(value).digest("hex");
              }
            } catch {
              issues.push({
                code: "STAGING_CONFIG_UNAVAILABLE",
                field: `dependencies.${dependency.name}.externalSecret`,
                message: `Falha ao resolver o segredo da dependência externa "${dependency.name}".`,
              });
            }
          }
        }
      }
      dependencies.push(mapped);
    }

    if (issues.length > 0) {
      return { ok: false, legacy: false, config: null, dependencies: [], issues };
    }

    const config: StagingProjectConfig = {
      mode: "isolated",
      ttlMinutes: record.ttlMinutes,
      allowEgress: record.allowEgress,
      app: record.app,
      env,
    };

    return { ok: true, legacy: false, config, dependencies, issues: [] };
  }
}

