import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { CORE_ENV_REPOSITORY, type CoreEnvRepository } from "../domain/core-env.repository";
import { isMaskedValue, isSensitiveEnvKey } from "../domain/core-env-secrets";

const ENV_VAR_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Grava UMA variável de ambiente do Core.
 *
 * Regra crítica: se o valor recebido for a MÁSCARA ("********"), a gravação
 * é ignorada e o valor já gravado é preservado. Sem isso, salvar a tela de
 * Configurações (que agora mostra valores mascarados) apagaria de verdade o
 * JWT_SECRET e o ENV_ENCRYPTION_KEY do ambiente.
 */
@Injectable()
export class SetCoreEnvVarUseCase {
  constructor(@Inject(CORE_ENV_REPOSITORY) private readonly envRepository: CoreEnvRepository) {}

  async execute(key: string, value: string): Promise<{ written: boolean }> {
    const normalizedKey = key.trim().toUpperCase();
    if (!ENV_VAR_KEY_PATTERN.test(normalizedKey)) {
      throw new BadRequestException(
        apiError("ENV_VAR_KEY_INVALID", `Nome de variável inválido: "${key}". Use apenas letras, números e _ (sem começar por número).`),
      );
    }

    if (isMaskedValue(value) && isSensitiveEnvKey(normalizedKey)) {
      // "Não mexe" - o valor real continua no arquivo.
      return { written: false };
    }

    await this.envRepository.upsertOne(normalizedKey, value);
    return { written: true };
  }
}
