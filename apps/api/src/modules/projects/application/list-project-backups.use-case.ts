import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import {
  MANAGED_DATABASE_REPOSITORY,
  type ManagedDatabaseRepository,
} from "../domain/managed-database.repository";
import { pickPrimaryDatabase } from "../domain/managed-database.entity";
import { ProjectBackupsService, type ProjectBackupEntry } from "../infrastructure/project-backups.service";

@Injectable()
export class ListProjectBackupsUseCase {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    @Inject(MANAGED_DATABASE_REPOSITORY) private readonly databaseRepository: ManagedDatabaseRepository,
    private readonly projectBackups: ProjectBackupsService,
  ) {}

  async execute(projectId: string): Promise<ProjectBackupEntry[]> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(apiError("PROJECT_NOT_FOUND", `Projeto ${projectId} não encontrado`));
    }

    const all = await this.databaseRepository.findAllByProjectId(projectId);
    const database = pickPrimaryDatabase(all.filter((db) => db.type !== "custom"));
    if (!database) {
      throw new BadRequestException(
        apiError("MANAGED_DATABASE_REQUIRED", "Este projeto não tem um banco gerenciado pelo Korrelo."),
      );
    }

    return this.projectBackups.list(project, database.type as "postgres" | "redis" | "mongodb");
  }
}
