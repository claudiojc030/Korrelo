import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import {
  MANAGED_DATABASE_REPOSITORY,
  type ManagedDatabaseRepository,
} from "../domain/managed-database.repository";
import { LOG_READER, type LogReader } from "../domain/log-reader";

export type LogTarget = "app" | "database";

@Injectable()
export class GetProjectLogsUseCase {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    @Inject(MANAGED_DATABASE_REPOSITORY) private readonly managedDatabaseRepository: ManagedDatabaseRepository,
    @Inject(LOG_READER) private readonly logReader: LogReader,
  ) {}

  async execute(projectId: string, target: LogTarget, tailLines: number): Promise<{ containerName: string; content: string }> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Projeto ${projectId} não encontrado`);
    }
    if (!project.containerName) {
      throw new BadRequestException("Este projeto ainda não foi implantado, não há container pra ler logs.");
    }

    let containerName = project.containerName;
    if (target === "database") {
      const managedDatabase = await this.managedDatabaseRepository.findByProjectId(projectId);
      if (!managedDatabase || managedDatabase.type === "custom") {
        throw new BadRequestException(
          "Este projeto não tem um banco de dados gerenciado com container (bancos externos não têm logs aqui).",
        );
      }
      containerName = `${project.containerName}-db-1`;
    }

    const content = await this.logReader.readLogs(containerName, tailLines);
    return { containerName, content };
  }
}
