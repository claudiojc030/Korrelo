import type { Project } from "./project.entity";

export const PROJECT_REPOSITORY = Symbol("PROJECT_REPOSITORY");

export interface ProjectRepository {
  findAll(): Promise<Project[]>;
  save(project: Project): Promise<Project>;
}
