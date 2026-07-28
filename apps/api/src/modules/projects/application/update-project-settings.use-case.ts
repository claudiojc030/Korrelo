import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import type { Project } from "../domain/project.entity";

const BRANCH_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/;

export interface UpdateProjectSettingsInput {
  terminalEnabled?: boolean;
  databaseEnabled?: boolean;
  autoDeployEnabled?: boolean;
  deployBranch?: string;
}

@Injectable()
export class UpdateProjectSettingsUseCase {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly repository: ProjectRepository) {}

  async execute(projectId: string, input: UpdateProjectSettingsInput): Promise<Project> {
    const project = await this.repository.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Projeto ${projectId} não encontrado`);
    }

    const deployBranch = input.deployBranch?.trim() || project.deployBranch;
    if (!BRANCH_NAME_PATTERN.test(deployBranch)) {
      throw new BadRequestException(`Nome de branch inválido: "${deployBranch}".`);
    }

    let updated = project.withSettings(
      input.terminalEnabled ?? project.terminalEnabled,
      input.databaseEnabled ?? project.databaseEnabled,
    );
    updated = updated.withAutoDeploy(input.autoDeployEnabled ?? project.autoDeployEnabled, deployBranch);

    return this.repository.save(updated);
  }
}
