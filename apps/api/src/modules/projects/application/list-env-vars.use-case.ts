import { Inject, Injectable } from "@nestjs/common";
import { ENV_VAR_REPOSITORY, type EnvVarRepository } from "../domain/env-var.repository";
import type { EnvVar } from "../domain/env-var.entity";

@Injectable()
export class ListEnvVarsUseCase {
  constructor(@Inject(ENV_VAR_REPOSITORY) private readonly repository: EnvVarRepository) {}

  execute(projectId: string): Promise<EnvVar[]> {
    return this.repository.findByProjectId(projectId);
  }
}
