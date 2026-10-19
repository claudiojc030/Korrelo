import { Inject, Injectable, Logger, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { USER_REPOSITORY, type UserRepository } from "../../auth/domain/user.repository";
import { PASSWORD_HASHER, type PasswordHasher } from "../../auth/domain/password-hasher";
import { CORE_ENV_REPOSITORY, type CoreEnvRepository } from "../domain/core-env.repository";

const ENV_VAR_KEY_PATTERN = /^[A-Z0-9_]+$/;

/**
 * Revela o valor REAL de UMA variável de ambiente do Core.
 *
 * A listagem comum devolve valores mascarados (ver ListCoreEnvUseCase). Esta
 * rota é a exceção: exige a SENHA do administrador, uma variável por vez, e
 * fica com limite de tentativas bem mais apertado que o resto da API.
 *
 * O valor revelado NUNCA é logado - só o nome da variável.
 */
@Injectable()
export class RevealCoreEnvVarUseCase {
  private readonly logger = new Logger(RevealCoreEnvVarUseCase.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly userRepository: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly passwordHasher: PasswordHasher,
    @Inject(CORE_ENV_REPOSITORY) private readonly envRepository: CoreEnvRepository,
  ) {}

  async execute(userId: string, key: string, password: string): Promise<{ key: string; value: string }> {
    const normalizedKey = key.trim().toUpperCase();
    if (!ENV_VAR_KEY_PATTERN.test(normalizedKey)) {
      throw new NotFoundException(apiError("ENV_VAR_NOT_FOUND", `Variável "${key}" não encontrada.`));
    }

    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new UnauthorizedException(apiError("SESSION_EXPIRED", "Sessão expirada. Faça login novamente."));
    }

    const passwordMatches = await this.passwordHasher.compare(password ?? "", user.passwordHash);
    if (!passwordMatches) {
      this.logger.warn(`[settings] tentativa de revelação sem senha correta para "${normalizedKey}"`);
      throw new UnauthorizedException(apiError("INCORRECT_PASSWORD", "Senha incorreta."));
    }

    const value = await this.envRepository.getValue(normalizedKey);
    if (value === null) {
      throw new NotFoundException(apiError("ENV_VAR_NOT_FOUND", `Variável "${key}" não encontrada.`));
    }

    this.logger.log(`[settings] variável "${normalizedKey}" revelada pelo administrador`);
    return { key: normalizedKey, value };
  }
}
