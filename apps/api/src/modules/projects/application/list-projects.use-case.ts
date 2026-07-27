import { Inject, Injectable } from "@nestjs/common";
import type { Project } from "../domain/project.entity";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";

@Injectable()
export class ListProjectsUseCase {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly repository: ProjectRepository,
  ) {}

  execute(): Promise<Project[]> {
    return this.repository.findAll();
  }
}
