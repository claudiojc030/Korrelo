import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { promises as fs } from "node:fs";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { getProjectWorkspacePath } from "../infrastructure/workspace-paths";
import { resolveSafeProjectPath } from "../infrastructure/project-file-path";

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2MB — editor de texto, não visualizador de binário grande.

function looksLikeBinary(buffer: Buffer): boolean {
  const sampleSize = Math.min(buffer.length, 8000);
  for (let i = 0; i < sampleSize; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

@Injectable()
export class ReadProjectFileUseCase {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository) {}

  async execute(projectId: string, relativePath: string): Promise<{ content: string }> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Projeto ${projectId} não encontrado`);
    }

    const workspaceRoot = getProjectWorkspacePath(projectId);
    const targetPath = resolveSafeProjectPath(workspaceRoot, relativePath);

    const stat = await fs.stat(targetPath);
    if (stat.isDirectory()) {
      throw new BadRequestException("Esse caminho é uma pasta, não um arquivo.");
    }
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException(
        `Arquivo grande demais pra abrir aqui (${Math.round(stat.size / 1024)}KB, limite 2MB).`,
      );
    }

    const buffer = await fs.readFile(targetPath);
    if (looksLikeBinary(buffer)) {
      throw new BadRequestException("Esse arquivo parece binário — não dá pra abrir como texto.");
    }

    return { content: buffer.toString("utf-8") };
  }
}
