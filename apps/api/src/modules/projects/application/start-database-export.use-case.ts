import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import {
  MANAGED_DATABASE_REPOSITORY,
  type ManagedDatabaseRepository,
} from "../domain/managed-database.repository";
import { DATABASE_EXPORTER, type DatabaseExporter } from "../domain/database-exporter";

@Injectable()
export class StartDatabaseExportUseCase {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    @Inject(MANAGED_DATABASE_REPOSITORY) private readonly databaseRepository: ManagedDatabaseRepository,
    @Inject(DATABASE_EXPORTER) private readonly databaseExporter: DatabaseExporter,
  ) {}

  async execute(projectId: string): Promise<{ alreadyRunning: boolean }> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(apiError("PROJECT_NOT_FOUND", `Projeto ${projectId} não encontrado`));
    }
    if (!project.containerName || project.status !== "running") {
      throw new BadRequestException(
        apiError("PROJECT_NOT_RUNNING", "O projeto precisa estar implantado e rodando pra exportar o banco."),
      );
    }

    const database = await this.databaseRepository.findByProjectId(projectId);
    if (!database || database.type === "custom") {
      throw new BadRequestException(
        apiError("MANAGED_DATABASE_REQUIRED", "Este projeto não tem um banco gerenciado pelo Korrelo pra exportar."),
      );
    }

    const containerName = `${project.containerName}-db-1`;
    return this.databaseExporter.start(projectId, {
      containerName,
      dbType: database.type,
      username: database.username,
      password: database.password,
      databaseName: database.databaseName,
    });
  }
}
