import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { CORE_ENV_REPOSITORY, type CoreEnvRepository } from "../domain/core-env.repository";

const ENV_VAR_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

@Injectable()
export class SetCoreEnvVarUseCase {
  constructor(@Inject(CORE_ENV_REPOSITORY) private readonly envRepository: CoreEnvRepository) {}

  async execute(key: string, value: string): Promise<void> {
    const normalizedKey = key.trim().toUpperCase();
    if (!ENV_VAR_KEY_PATTERN.test(normalizedKey)) {
      throw new BadRequestException(
        apiError(
          "ENV_VAR_KEY_INVALID",
          `Nome de variável inválido: "${key}". Use apenas letras, números e _ (sem começar com número).`,
        ),
      );
    }
    await this.envRepository.upsertOne(normalizedKey, value);
  }
}
