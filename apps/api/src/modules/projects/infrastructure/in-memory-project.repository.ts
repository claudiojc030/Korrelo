import { Injectable } from "@nestjs/common";
import type { Project } from "../domain/project.entity";
import type { ProjectRepository } from "../domain/project.repository";

@Injectable()
export class InMemoryProjectRepository implements ProjectRepository {
  private readonly projects: Project[] = [];

  async findAll(): Promise<Project[]> {
    return this.projects;
  }

  async save(project: Project): Promise<Project> {
    this.projects.push(project);
    return project;
  }
}
