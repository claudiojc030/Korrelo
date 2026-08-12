import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import {
  MANAGED_DATABASE_REPOSITORY,
  type ManagedDatabaseRepository,
} from "../domain/managed-database.repository";
import { MONGO_IMPORTER, type MongoImporter } from "../domain/mongo-importer";

@Injectable()
export class StartMongoImportUseCase {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    @Inject(MANAGED_DATABASE_REPOSITORY) private readonly databaseRepository: ManagedDatabaseRepository,
    @Inject(MONGO_IMPORTER) private readonly mongoImporter: MongoImporter,
  ) {}

  async execute(projectId: string, sourceUri: string): Promise<{ alreadyRunning: boolean }> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(apiError("PROJECT_NOT_FOUND", `Projeto ${projectId} não encontrado`));
    }
    if (!project.containerName || project.status !== "running") {
      throw new BadRequestException(
        apiError("PROJECT_NOT_RUNNING", "O projeto precisa estar implantado e rodando antes de importar dados."),
      );
    }

    const database = await this.databaseRepository.findByProjectId(projectId);
    if (!database || database.type !== "mongodb") {
      throw new BadRequestException(
        apiError("MONGODB_NOT_PROVISIONED", "Provisione um banco MongoDB neste projeto antes de importar dados externos."),
      );
    }

    const trimmedSourceUri = sourceUri?.trim();
    if (!trimmedSourceUri) {
      throw new BadRequestException(apiError("SOURCE_URI_REQUIRED", "Informe a connection string do MongoDB de origem."));
    }

    // Sem o nome do banco na connection string, o mongodump baixa TODOS os
    // bancos do cluster de origem, e o mongorestore recria cada um com o
    // nome ORIGINAL dentro do container - ignorando completamente o banco
    // do projeto. Os dados pareciam importar com sucesso mas nunca apareciam
    // (foram parar num banco "solto" que ninguém lê).
    const sourceDb = this.extractDbName(trimmedSourceUri);
    if (!sourceDb) {
      throw new BadRequestException(
        apiError(
          "SOURCE_DATABASE_NAME_REQUIRED",
          "A connection string precisa incluir o nome do banco (ex.: .../meubanco?...), não só o cluster.",
        ),
      );
    }

    const containerName = `${project.containerName}-db-1`;
    const targetUri = `mongodb://${database.username}:${database.password}@localhost:27017/${database.databaseName}?authSource=admin`;
    return this.mongoImporter.start(projectId, containerName, trimmedSourceUri, targetUri, sourceDb, database.databaseName as string);
  }

  private extractDbName(uri: string): string | null {
    try {
      const pathname = new URL(uri).pathname;
      const dbName = pathname.replace(/^\//, "").trim();
      return dbName || null;
    } catch {
      return null;
    }
  }
}
