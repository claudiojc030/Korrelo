import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { promises as fs } from "node:fs";
import { apiError } from "../../../infrastructure/api-error";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { getProjectWorkspacePath } from "../infrastructure/workspace-paths";
import { resolveSafeProjectPath } from "../infrastructure/project-file-path";

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;

@Injectable()
export class WriteProjectFileUseCase {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository) {}

  async execute(projectId: string, relativePath: string, content: string): Promise<void> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(apiError("PROJECT_NOT_FOUND", `Projeto ${projectId} não encontrado`));
    }
    if (Buffer.byteLength(content, "utf-8") > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException(apiError("CONTENT_TOO_LARGE", "Conteúdo grande demais pra salvar aqui (limite 2MB)."));
    }

    const workspaceRoot = getProjectWorkspacePath(projectId);
    const targetPath = resolveSafeProjectPath(workspaceRoot, relativePath);

    // Só permite sobrescrever arquivo existente. Criar arquivo novo pelo
    // editor fica fora de escopo por enquanto (evita, por exemplo, criar
    // caminhos com pastas intermediárias inexistentes sem querer).
    const stat = await fs.stat(targetPath).catch(() => null);
    if (!stat || stat.isDirectory()) {
      throw new BadRequestException(apiError("FILE_NOT_FOUND", "Arquivo não encontrado."));
    }

    await fs.writeFile(targetPath, content, "utf-8");
  }
}
