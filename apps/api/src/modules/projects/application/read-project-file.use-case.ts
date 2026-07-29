import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { promises as fs } from "node:fs";
import { apiError } from "../../../infrastructure/api-error";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { getProjectWorkspacePath } from "../infrastructure/workspace-paths";
import { resolveSafeProjectPath } from "../infrastructure/project-file-path";

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2MB, é editor de texto, não visualizador de binário grande.

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
      throw new NotFoundException(apiError("PROJECT_NOT_FOUND", `Projeto ${projectId} não encontrado`));
    }

    const workspaceRoot = getProjectWorkspacePath(projectId);
    const targetPath = resolveSafeProjectPath(workspaceRoot, relativePath);

    const stat = await fs.stat(targetPath);
    if (stat.isDirectory()) {
      throw new BadRequestException(apiError("PATH_IS_DIRECTORY", "Esse caminho é uma pasta, não um arquivo."));
    }
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException(
        apiError("FILE_TOO_LARGE", `Arquivo grande demais pra abrir aqui (${Math.round(stat.size / 1024)}KB, limite 2MB).`),
      );
    }

    const buffer = await fs.readFile(targetPath);
    if (looksLikeBinary(buffer)) {
      throw new BadRequestException(apiError("FILE_IS_BINARY", "Esse arquivo parece binário, não dá pra abrir como texto."));
    }

    return { content: buffer.toString("utf-8") };
  }
}
