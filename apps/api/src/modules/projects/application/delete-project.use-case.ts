import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { promises as fs } from "node:fs";
import { apiError } from "../../../infrastructure/api-error";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { CONTAINER_ORCHESTRATOR, type ContainerOrchestrator } from "../domain/container-orchestrator";
import { getProjectWorkspacePath } from "../infrastructure/workspace-paths";

@Injectable()
export class DeleteProjectUseCase {
  private readonly logger = new Logger(DeleteProjectUseCase.name);

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly repository: ProjectRepository,
    @Inject(CONTAINER_ORCHESTRATOR) private readonly orchestrator: ContainerOrchestrator,
  ) {}

  async execute(projectId: string): Promise<void> {
    const project = await this.repository.findById(projectId);
    if (!project) {
      throw new NotFoundException(apiError("PROJECT_NOT_FOUND", `Projeto ${projectId} não encontrado`));
    }

    const projectPath = getProjectWorkspacePath(project.id);

    if (project.containerName) {
      try {
        await this.orchestrator.teardown({ projectPath, containerName: project.containerName });
      } catch (error) {
        this.logger.warn(`Falha ao remover container ${project.containerName} durante delete: ${error}`);
      }
    }

    try {
      await fs.rm(projectPath, { recursive: true, force: true });
    } catch (error) {
      this.logger.warn(`Falha ao limpar workspace de ${project.id} durante delete: ${error}`);
    }

    await this.repository.delete(project.id);
  }
}
