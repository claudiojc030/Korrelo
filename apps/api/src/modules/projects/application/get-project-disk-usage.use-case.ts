import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { ProjectDiskUsageService } from "../infrastructure/project-disk-usage.service";
import { getProjectWorkspacePath } from "../infrastructure/workspace-paths";

@Injectable()
export class GetProjectDiskUsageUseCase {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly repository: ProjectRepository,
    private readonly diskUsageService: ProjectDiskUsageService,
  ) {}

  async execute(projectId: string): Promise<{ diskUsageMb: number }> {
    const project = await this.repository.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Projeto ${projectId} não encontrado`);
    }

    const diskUsageMb = await this.diskUsageService.getUsageMb(getProjectWorkspacePath(project.id));
    return { diskUsageMb };
  }
}
