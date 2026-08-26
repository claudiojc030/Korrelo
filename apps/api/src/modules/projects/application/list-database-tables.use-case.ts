import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import {
  MANAGED_DATABASE_REPOSITORY,
  type ManagedDatabaseRepository,
} from "../domain/managed-database.repository";
import { pickPrimaryDatabase } from "../domain/managed-database.entity";
import { DATABASE_QUERY_RUNNER, type DatabaseQueryRunner } from "../domain/database-query-runner";

@Injectable()
export class ListDatabaseTablesUseCase {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    @Inject(MANAGED_DATABASE_REPOSITORY) private readonly databaseRepository: ManagedDatabaseRepository,
    @Inject(DATABASE_QUERY_RUNNER) private readonly queryRunner: DatabaseQueryRunner,
  ) {}

  async execute(projectId: string): Promise<string[]> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(apiError("PROJECT_NOT_FOUND", `Projeto ${projectId} não encontrado`));
    }
    if (!project.containerName) {
      throw new BadRequestException(
        apiError("DATABASE_CONTAINER_NOT_DEPLOYED", "Este projeto ainda não foi implantado, não há container de banco pra navegar."),
      );
    }

    const all = await this.databaseRepository.findAllByProjectId(projectId);
    const database = pickPrimaryDatabase(all.filter((db) => db.type !== "custom"));
    if (!database) {
      throw new BadRequestException(apiError("NO_MANAGED_DATABASE", "Este projeto não tem um banco de dados gerenciado com container."));
    }

    const containerName = `${project.containerName}-${database.serviceName}-1`;
    return this.queryRunner.listTables(containerName, database);
  }
}
