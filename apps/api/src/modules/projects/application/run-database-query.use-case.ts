import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import {
  MANAGED_DATABASE_REPOSITORY,
  type ManagedDatabaseRepository,
} from "../domain/managed-database.repository";
import {
  DATABASE_QUERY_RUNNER,
  type DatabaseQueryResult,
  type DatabaseQueryRunner,
} from "../domain/database-query-runner";

@Injectable()
export class RunDatabaseQueryUseCase {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    @Inject(MANAGED_DATABASE_REPOSITORY) private readonly databaseRepository: ManagedDatabaseRepository,
    @Inject(DATABASE_QUERY_RUNNER) private readonly queryRunner: DatabaseQueryRunner,
  ) {}

  async execute(projectId: string, query: string): Promise<DatabaseQueryResult> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Projeto ${projectId} não encontrado`);
    }
    if (!project.containerName) {
      throw new BadRequestException("Este projeto ainda não foi implantado — não há container de banco pra consultar.");
    }

    const database = await this.databaseRepository.findByProjectId(projectId);
    if (!database || database.type === "custom") {
      throw new BadRequestException("Este projeto não tem um banco de dados gerenciado com container.");
    }

    const containerName = `${project.containerName}-db-1`;
    return this.queryRunner.runQuery(containerName, database, query);
  }
}
