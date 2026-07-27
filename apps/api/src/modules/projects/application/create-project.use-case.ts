import { Inject, Injectable } from "@nestjs/common";
import { Project } from "../domain/project.entity";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";

export interface CreateProjectInput {
  name: string;
  repoUrl: string;
}

@Injectable()
export class CreateProjectUseCase {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly repository: ProjectRepository,
  ) {}

  execute(input: CreateProjectInput): Promise<Project> {
    const project = Project.create(input.name, input.repoUrl);
    return this.repository.save(project);
  }
}
