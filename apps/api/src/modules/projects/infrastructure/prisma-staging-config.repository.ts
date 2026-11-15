import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { EnvVarCipher } from "../../../infrastructure/crypto/env-var-cipher";
import {
  StagingConfigValidationError,
  type PersistedStagingConfig,
  type PersistedStagingDependency,
  type StagingConfigIssue,
  type StagingConfigPersistenceInput,
  type StagingConfigRepository,
} from "../domain/persisted-staging-config";
import { SUPPORTED_STAGING_DEPENDENCY_KINDS } from "../domain/staging-planner";

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEPENDENCY_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const SUPPORTED_KINDS = new Set<string>(SUPPORTED_STAGING_DEPENDENCY_KINDS);

/**
 * Repositório interno da configuração persistida (P1B1).
 *
 * - não é registrado em controller;
 * - save/delete são operações internas, usadas por testes e por uma futura
 *   camada autenticada;
 * - findByProjectId NUNCA devolve valores secretos, apenas metadados;
 * - valores são cifrados com EnvVarCipher (AES-256-GCM) antes da escrita.
 */
@Injectable()
export class PrismaStagingConfigRepository implements StagingConfigRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: EnvVarCipher,
  ) {}

  async findByProjectId(projectId: string): Promise<PersistedStagingConfig | null> {
    const row = await this.prisma.projectStagingConfig.findUnique({
      where: { projectId },
      include: { dependencies: true },
    });
    if (!row) return null;

    const secrets = await this.prisma.stagingSecret.findMany({
      where: { projectId },
      select: { id: true, key: true, createdAt: true, updatedAt: true },
      orderBy: { key: "asc" },
    });

    return {
      id: row.id,
      projectId: row.projectId,
      mode: row.mode,
      ttlMinutes: row.ttlMinutes,
      allowEgress: row.allowEgress,
      app: {
        memoryMb: row.appMemoryMb,
        cpu: row.appCpu,
        diskMb: row.appDiskMb,
      },
      dependencies: row.dependencies.map((dependency) => this.toDependency(dependency)),
      secrets,
    };
  }

  async save(projectId: string, input: StagingConfigPersistenceInput): Promise<PersistedStagingConfig> {
    validate(projectId, input);

    const secrets = input.secrets ?? [];
    const dependencyRows = input.dependencies ?? [];

    await this.prisma.$transaction(async (tx) => {
      // A configuração é a raiz; removê-la remove dependências por cascade.
      await tx.projectStagingConfig.deleteMany({ where: { projectId } });

      const keepKeys = secrets.map((secret) => secret.key);
      await tx.stagingSecret.deleteMany({
        where: { projectId, key: { notIn: keepKeys } },
      });

      const secretIds = new Map<string, string>();
      for (const secret of secrets) {
        const row = await tx.stagingSecret.upsert({
          where: { projectId_key: { projectId, key: secret.key } },
          create: {
            projectId,
            key: secret.key,
            valueCiphertext: this.cipher.encrypt(secret.value),
          },
          update: {
            valueCiphertext: this.cipher.encrypt(secret.value),
          },
        });
        secretIds.set(secret.key, row.id);
      }

      await tx.projectStagingConfig.create({
        data: {
          projectId,
          mode: input.mode,
          ttlMinutes: input.ttlMinutes,
          allowEgress: input.allowEgress === true,
          appMemoryMb: input.app.memoryMb,
          appCpu: input.app.cpu,
          appDiskMb: input.app.diskMb,
          dependencies: {
            create: dependencyRows.map((dependency) => ({
              name: dependency.name.trim().toLowerCase(),
              kind: dependency.kind.trim().toLowerCase(),
              mode: dependency.mode ?? defaultMode(dependency.kind),
              envKey: dependency.envKey ?? null,
              targetScheme: dependency.target?.scheme ?? null,
              targetHost: dependency.target?.host ?? null,
              targetPort: dependency.target?.port ?? null,
              targetDatabase: dependency.target?.database ?? null,
              memoryMb: dependency.resources?.memoryMb ?? null,
              cpu: dependency.resources?.cpu ?? null,
              diskMb: dependency.resources?.diskMb ?? null,
              externalSecretId: dependency.externalSecretKey
                ? secretIds.get(dependency.externalSecretKey) ?? null
                : null,
              healthcheck: dependency.healthcheck ?? null,
            })),
          },
        },
      });
    });

    const saved = await this.findByProjectId(projectId);
    if (!saved) throw new Error("Configuração de staging não pôde ser relida após a gravação.");
    return saved;
  }

  async deleteByProjectId(projectId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.projectStagingConfig.deleteMany({ where: { projectId } }),
      this.prisma.stagingSecret.deleteMany({ where: { projectId } }),
    ]);
  }

  async resolveSecretValue(projectId: string, key: string): Promise<string | null> {
    const row = await this.prisma.stagingSecret.findUnique({
      where: { projectId_key: { projectId, key } },
      select: { valueCiphertext: true },
    });
    if (!row) return null;
    return this.cipher.decrypt(row.valueCiphertext);
  }

  private toDependency(row: {
    id: string;
    name: string;
    kind: string;
    mode: string;
    envKey: string | null;
    targetScheme: string | null;
    targetHost: string | null;
    targetPort: number | null;
    targetDatabase: string | null;
    memoryMb: number | null;
    cpu: number | null;
    diskMb: number | null;
    externalSecretId: string | null;
    healthcheck: string | null;
  }): PersistedStagingDependency {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      mode: row.mode,
      envKey: row.envKey,
      target:
        row.targetScheme && row.targetHost && row.targetPort
          ? {
              scheme: row.targetScheme,
              host: row.targetHost,
              port: row.targetPort,
              database: row.targetDatabase,
            }
          : null,
      resources:
        row.memoryMb !== null && row.cpu !== null && row.diskMb !== null
          ? { memoryMb: row.memoryMb, cpu: row.cpu, diskMb: row.diskMb }
          : null,
      externalSecretId: row.externalSecretId,
      healthcheck: row.healthcheck,
    };
  }
}

function defaultMode(kind: string): string {
  const normalized = kind.trim().toLowerCase();
  if (normalized === "external") return "external";
  if (normalized === "sqlite") return "file";
  return "ephemeral";
}

function validate(projectId: string, input: StagingConfigPersistenceInput): void {
  const issues: StagingConfigIssue[] = [];
  const add = (code: string, field: string, message: string) => issues.push({ code, field, message });

  if (!projectId?.trim()) add("STAGING_CONFIG_INCOMPLETE", "projectId", "projectId é obrigatório.");
  if (input.mode !== "isolated") {
    add("STAGING_CONFIG_INVALID", "mode", "Somente mode=isolated é persistido nesta fase.");
  }
  if (!Number.isInteger(input.ttlMinutes) || input.ttlMinutes <= 0) {
    add("STAGING_CONFIG_INVALID", "ttlMinutes", "ttlMinutes precisa ser inteiro > 0.");
  }
  validateResource(input.app, "app", true, add);

  const secrets = input.secrets ?? [];
  const secretKeys = new Set<string>();
  for (const [index, secret] of secrets.entries()) {
    if (!ENV_KEY_PATTERN.test(secret.key)) {
      add("STAGING_CONFIG_INVALID", `secrets[${index}].key`, `Chave de segredo inválida: "${secret.key}".`);
    }
    if (!secret.value) {
      add("STAGING_CONFIG_INVALID", `secrets[${index}].value`, "Valor de segredo não pode ser vazio.");
    }
    if (secretKeys.has(secret.key)) {
      add("STAGING_CONFIG_INVALID", `secrets[${index}].key`, `Segredo duplicado: "${secret.key}".`);
    }
    secretKeys.add(secret.key);
  }

  const names = new Set<string>();
  for (const [index, dependency] of (input.dependencies ?? []).entries()) {
    const field = `dependencies[${index}]`;
    const name = dependency.name?.trim().toLowerCase() ?? "";
    const kind = dependency.kind?.trim().toLowerCase() ?? "";
    if (!DEPENDENCY_NAME_PATTERN.test(name)) {
      add("STAGING_CONFIG_INVALID", `${field}.name`, `Nome de dependência inválido: "${dependency.name}".`);
    } else if (names.has(name)) {
      add("STAGING_CONFIG_INVALID", `${field}.name`, `Dependência duplicada: "${name}".`);
    }
    names.add(name);

    if (!SUPPORTED_KINDS.has(kind)) {
      add("STAGING_CONFIG_INVALID", `${field}.kind`, `Tipo de dependência não suportado: "${dependency.kind}".`);
      continue;
    }

    if (kind === "external") {
      if (!dependency.envKey || !ENV_KEY_PATTERN.test(dependency.envKey)) {
        add("STAGING_CONFIG_INCOMPLETE", `${field}.envKey`, "Dependência externa exige envKey válido.");
      }
      if (!dependency.target) {
        add("STAGING_CONFIG_INCOMPLETE", `${field}.target`, "Dependência externa exige target.");
      } else if (
        !dependency.target.scheme?.trim() ||
        !dependency.target.host?.trim() ||
        !Number.isInteger(dependency.target.port) ||
        dependency.target.port <= 0
      ) {
        add("STAGING_CONFIG_INVALID", `${field}.target`, "Target externo exige scheme, host e port.");
      }
      if (!dependency.externalSecretKey) {
        add("STAGING_CONFIG_INCOMPLETE", `${field}.externalSecretKey`, "Dependência externa exige segredo de staging.");
      } else if (!secretKeys.has(dependency.externalSecretKey)) {
        add(
          "STAGING_CONFIG_INCOMPLETE",
          `${field}.externalSecretKey`,
          `Segredo de staging "${dependency.externalSecretKey}" não foi informado.`,
        );
      }
      if (dependency.resources) {
        add("STAGING_CONFIG_INVALID", `${field}.resources`, "Dependência externa não consome recursos locais.");
      }
      continue;
    }

    validateResource(dependency.resources ?? null, `${field}.resources`, kind !== "sqlite", add);
    if (kind !== "sqlite" && (!dependency.envKey || !ENV_KEY_PATTERN.test(dependency.envKey))) {
      add("STAGING_CONFIG_INCOMPLETE", `${field}.envKey`, "Dependência gerenciada exige envKey válido.");
    }
    if (kind === "sqlite" && dependency.mode && dependency.mode !== "file") {
      add("STAGING_CONFIG_INVALID", `${field}.mode`, "SQLite deve usar mode=file.");
    }
    if (kind !== "sqlite" && dependency.mode === "external") {
      add("STAGING_CONFIG_INVALID", `${field}.mode`, "Use kind=external para banco externo.");
    }
  }

  if (issues.length > 0) throw new StagingConfigValidationError(issues);
}

function validateResource(
  resource: { memoryMb: number; cpu: number; diskMb: number } | null,
  field: string,
  positiveCpuMemory: boolean,
  add: (code: string, field: string, message: string) => void,
): void {
  if (!resource) {
    add("STAGING_CONFIG_INCOMPLETE", field, "Recursos explícitos são obrigatórios.");
    return;
  }
  const validMemory = positiveCpuMemory ? resource.memoryMb > 0 : resource.memoryMb >= 0;
  const validCpu = positiveCpuMemory ? resource.cpu > 0 : resource.cpu >= 0;
  if (!Number.isFinite(resource.memoryMb) || !validMemory) {
    add("STAGING_CONFIG_INVALID", `${field}.memoryMb`, "memoryMb inválido para o serviço.");
  }
  if (!Number.isFinite(resource.cpu) || !validCpu) {
    add("STAGING_CONFIG_INVALID", `${field}.cpu`, "cpu inválida para o serviço.");
  }
  if (!Number.isFinite(resource.diskMb) || resource.diskMb <= 0) {
    add("STAGING_CONFIG_INVALID", `${field}.diskMb`, "diskMb precisa ser > 0.");
  }
}



