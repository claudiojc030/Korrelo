import { Injectable } from "@nestjs/common";
import type { Project } from "../domain/project.entity";
import type { ProjectRepository } from "../domain/project.repository";

@Injectable()
export class InMemoryProjectRepository implements ProjectRepository {
  private readonly projects: Project[] = [];

  async findAll(): Promise<Project[]> {
    return this.projects;
  }

  async findById(id: string): Promise<Project | null> {
    return this.projects.find((p) => p.id === id) ?? null;
  }

  async save(project: Project): Promise<Project> {
    const index = this.projects.findIndex((p) => p.id === project.id);
    if (index >= 0) {
      this.projects[index] = project;
    } else {
      this.projects.push(project);
    }
    return project;
  }
}
