import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { promises as fs } from "node:fs";
import { apiError } from "../../../infrastructure/api-error";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { getProjectWorkspacePath } from "../infrastructure/workspace-paths";
import { resolveSafeProjectPath } from "../infrastructure/project-file-path";

export interface ProjectFileEntry {
  name: string;
  isDirectory: boolean;
}

const HIDDEN_TOP_LEVEL = new Set([".git", "node_modules"]);

@Injectable()
export class ListProjectFilesUseCase {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository) {}

  async execute(projectId: string, relativePath: string): Promise<ProjectFileEntry[]> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(apiError("PROJECT_NOT_FOUND", `Projeto ${projectId} não encontrado`));
    }

    const workspaceRoot = getProjectWorkspacePath(projectId);
    const targetPath = resolveSafeProjectPath(workspaceRoot, relativePath);

    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    return entries
      .filter((entry) => !HIDDEN_TOP_LEVEL.has(entry.name) && !entry.name.startsWith(".env"))
      .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }
}
