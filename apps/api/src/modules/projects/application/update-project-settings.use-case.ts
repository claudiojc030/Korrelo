import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import type { Project } from "../domain/project.entity";

export interface UpdateProjectSettingsInput {
  terminalEnabled?: boolean;
  databaseEnabled?: boolean;
}

@Injectable()
export class UpdateProjectSettingsUseCase {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly repository: ProjectRepository) {}

  async execute(projectId: string, input: UpdateProjectSettingsInput): Promise<Project> {
    const project = await this.repository.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Projeto ${projectId} não encontrado`);
    }

    const updated = project.withSettings(
      input.terminalEnabled ?? project.terminalEnabled,
      input.databaseEnabled ?? project.databaseEnabled,
    );
    return this.repository.save(updated);
  }
}
