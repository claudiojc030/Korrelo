import { Inject, Injectable } from "@nestjs/common";
import { CORE_ENV_REPOSITORY, type CoreEnvRepository } from "../domain/core-env.repository";
import { isSensitiveEnvKey, maskEnvValue } from "../domain/core-env-secrets";

/**
 * Lista as variáveis de ambiente do Core.
 *
 * ATENÇÃO: valores sensíveis (JWT_SECRET, ENV_ENCRYPTION_KEY, chave privada
 * do GitHub App, DATABASE_URL...) saem MASCARADOS. Antes, a resposta trazia
 * o `.env` inteiro, o que expunha a instalação inteira pra qualquer sessão
 * autenticada.
 *
 * Pra ver o valor de verdade de uma variável, existe uma rota explícita e
 * protegida por senha (ver RevealCoreEnvVarUseCase).
 */
@Injectable()
export class ListCoreEnvUseCase {
  constructor(@Inject(CORE_ENV_REPOSITORY) private readonly envRepository: CoreEnvRepository) {}

  async execute(): Promise<{ key: string; value: string; masked: boolean }[]> {
    const vars = await this.envRepository.list();
    return vars.map((variable) => {
      const sensitive = isSensitiveEnvKey(variable.key);
      return {
        key: variable.key,
        value: sensitive ? maskEnvValue(variable.key, variable.value) : variable.value,
        masked: sensitive,
      };
    });
  }
}
