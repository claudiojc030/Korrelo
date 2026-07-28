import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import * as path from "node:path";
import type { Project } from "../domain/project.entity";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { REPOSITORY_CLONER, type RepositoryCloner } from "../domain/repository-cloner";
import { STACK_DETECTOR, type StackDetector } from "../domain/stack-detector";

const WORKSPACE_DIR = process.env.FORGEDESK_WORKSPACE_DIR ?? path.join(process.cwd(), "workspace");

@Injectable()
export class ImportProjectUseCase {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly repository: ProjectRepository,
    @Inject(REPOSITORY_CLONER) private readonly cloner: RepositoryCloner,
    @Inject(STACK_DETECTOR) private readonly detector: StackDetector,
  ) {}

  async execute(projectId: string): Promise<Project> {
    const project = await this.repository.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Projeto ${projectId} não encontrado`);
    }

    const destPath = path.join(WORKSPACE_DIR, project.id);
    await this.cloner.cloneOrUpdate(project.repoUrl, destPath);

    const detectedStack = await this.detector.detect(destPath);
    const updatedProject = project.withDetectedStack(JSON.stringify(detectedStack));
    return this.repository.save(updatedProject);
  }
}
