import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Project } from "../domain/project.entity";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { STACK_DETECTOR, type StackDetector } from "../domain/stack-detector";

export interface DetectProjectStackInput {
  projectId: string;
  projectPath: string;
}

@Injectable()
export class DetectProjectStackUseCase {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly repository: ProjectRepository,
    @Inject(STACK_DETECTOR) private readonly detector: StackDetector,
  ) {}

  async execute(input: DetectProjectStackInput): Promise<Project> {
    const project = await this.repository.findById(input.projectId);
    if (!project) {
      throw new NotFoundException(`Projeto ${input.projectId} não encontrado`);
    }

    const detectedStack = await this.detector.detect(input.projectPath);
    const updatedProject = project.withDetectedStack(JSON.stringify(detectedStack));
    return this.repository.save(updatedProject);
  }
}
