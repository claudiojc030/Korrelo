import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import * as crypto from "node:crypto";
import { apiError } from "../../../infrastructure/api-error";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import {
  MANAGED_DATABASE_REPOSITORY,
  type ManagedDatabaseRepository,
} from "../domain/managed-database.repository";
import { ManagedDatabase, type DatabaseType } from "../domain/managed-database.entity";
import { ENV_VAR_REPOSITORY, type EnvVarRepository } from "../domain/env-var.repository";

const ENV_VAR_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_CUSTOM_ENV_VAR_KEY = "DATABASE_URL";

export interface ProvisionDatabaseOptions {
  connectionString?: string;
  envVarKey?: string;
  persistRedis?: boolean;
}

function buildConnectionEnvVar(db: ManagedDatabase): { key: string; value: string } {
  if (db.type === "custom") {
    return { key: db.envVarKey ?? DEFAULT_CUSTOM_ENV_VAR_KEY, value: db.connectionString ?? "" };
  }
  const host = db.serviceName as string;
  if (db.type === "postgres") {
    return {
      key: "DATABASE_URL",
      value: `postgresql://${db.username}:${db.password}@${host}:5432/${db.databaseName}`,
    };
  }
  if (db.type === "mongodb") {
    return {
      key: "MONGODB_URI",
      value: `mongodb://${db.username}:${db.password}@${host}:27017/${db.databaseName}?authSource=admin`,
    };
  }
  return { key: "REDIS_URL", value: `redis://:${db.password}@${host}:6379` };
}

@Injectable()
export class ProvisionDatabaseUseCase {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    @Inject(MANAGED_DATABASE_REPOSITORY) private readonly databaseRepository: ManagedDatabaseRepository,
    @Inject(ENV_VAR_REPOSITORY) private readonly envVarRepository: EnvVarRepository,
  ) {}

  async execute(projectId: string, type: DatabaseType, options: ProvisionDatabaseOptions = {}): Promise<ManagedDatabase> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(apiError("PROJECT_NOT_FOUND", `Projeto ${projectId} não encontrado`));
    }

    const existing = await this.databaseRepository.findAllByProjectId(projectId);
    if (existing.some((db) => db.type === type)) {
      throw new ConflictException(
        apiError(
          "DATABASE_ALREADY_PROVISIONED",
          `Este projeto já tem um banco do tipo "${type}" provisionado. Remova antes de criar outro do mesmo tipo.`,
        ),
      );
    }

    let database: ManagedDatabase;
    if (type === "custom") {
      const connectionString = options.connectionString?.trim();
      if (!connectionString) {
        throw new BadRequestException(apiError("CONNECTION_STRING_REQUIRED", "Informe a connection string do banco externo."));
      }
      const envVarKey = options.envVarKey?.trim() || DEFAULT_CUSTOM_ENV_VAR_KEY;
      if (!ENV_VAR_KEY_PATTERN.test(envVarKey)) {
        throw new BadRequestException(
          apiError(
            "ENV_VAR_KEY_INVALID",
            `Nome de variável inválido: "${envVarKey}". Use apenas letras, números e _ (sem começar com número).`,
          ),
        );
      }
      database = ManagedDatabase.createCustom(projectId, connectionString, envVarKey);
    } else {
      const password = crypto.randomBytes(16).toString("hex");
      // Primeiro banco gerenciado do projeto continua "db" (compatibilidade
      // com todo projeto que já rodava antes de existir suporte a mais de
      // um) - qualquer banco adicional ganha um nome de serviço próprio.
      const hasManagedDatabase = existing.some((db) => db.type !== "custom");
      const serviceName = hasManagedDatabase ? `db-${type}` : "db";
      database = ManagedDatabase.createManaged(projectId, type, serviceName, password, options.persistRedis ?? false);
    }

    await this.databaseRepository.save(database);

    const envVar = buildConnectionEnvVar(database);
    await this.envVarRepository.upsertOne(projectId, envVar);

    return database;
  }
}
