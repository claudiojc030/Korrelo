import type { Project } from "./project.entity";

export const PROJECT_REPOSITORY = Symbol("PROJECT_REPOSITORY");

export interface ProjectRepository {
  findAll(): Promise<Project[]>;
  findById(id: string): Promise<Project | null>;
  findByCustomDomain(customDomain: string): Promise<Project | null>;
  findByRepoUrl(repoUrl: string): Promise<Project[]>;
  save(project: Project): Promise<Project>;
  delete(id: string): Promise<void>;
}
