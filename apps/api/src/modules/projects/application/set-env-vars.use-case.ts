import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ENV_VAR_REPOSITORY, type EnvVarInput, type EnvVarRepository } from "../domain/env-var.repository";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import type { EnvVar } from "../domain/env-var.entity";

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

@Injectable()
export class SetEnvVarsUseCase {
  constructor(
    @Inject(ENV_VAR_REPOSITORY) private readonly repository: EnvVarRepository,
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
  ) {}

  async execute(projectId: string, vars: EnvVarInput[]): Promise<EnvVar[]> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Projeto ${projectId} não encontrado`);
    }

    const seenKeys = new Set<string>();
    for (const v of vars) {
      if (!KEY_PATTERN.test(v.key)) {
        throw new BadRequestException(
          `Nome de variável inválido: "${v.key}". Use apenas letras, números e _ (sem começar com número).`,
        );
      }
      if (seenKeys.has(v.key)) {
        throw new BadRequestException(`Variável duplicada: "${v.key}".`);
      }
      seenKeys.add(v.key);
    }

    return this.repository.replaceAll(projectId, vars);
  }
}
