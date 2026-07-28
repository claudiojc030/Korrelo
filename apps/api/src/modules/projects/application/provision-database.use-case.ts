import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import * as crypto from "node:crypto";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import {
  MANAGED_DATABASE_REPOSITORY,
  type ManagedDatabaseRepository,
} from "../domain/managed-database.repository";
import { ManagedDatabase, type DatabaseType } from "../domain/managed-database.entity";
import { ENV_VAR_REPOSITORY, type EnvVarRepository } from "../domain/env-var.repository";

function buildConnectionEnvVar(db: ManagedDatabase): { key: string; value: string } {
  if (db.type === "postgres") {
    return {
      key: "DATABASE_URL",
      value: `postgresql://${db.username}:${db.password}@db:5432/${db.databaseName}`,
    };
  }
  return { key: "REDIS_URL", value: `redis://:${db.password}@db:6379` };
}

@Injectable()
export class ProvisionDatabaseUseCase {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    @Inject(MANAGED_DATABASE_REPOSITORY) private readonly databaseRepository: ManagedDatabaseRepository,
    @Inject(ENV_VAR_REPOSITORY) private readonly envVarRepository: EnvVarRepository,
  ) {}

  async execute(projectId: string, type: DatabaseType): Promise<ManagedDatabase> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Projeto ${projectId} não encontrado`);
    }

    const existing = await this.databaseRepository.findByProjectId(projectId);
    if (existing) {
      throw new ConflictException(
        "Este projeto já tem um banco de dados provisionado. Remova antes de criar outro.",
      );
    }

    const password = crypto.randomBytes(16).toString("hex");
    const database = ManagedDatabase.create(projectId, type, password);
    await this.databaseRepository.save(database);

    const envVar = buildConnectionEnvVar(database);
    await this.envVarRepository.upsertOne(projectId, envVar);

    return database;
  }
}
