import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { CORE_ENV_REPOSITORY, type CoreEnvRepository } from "../domain/core-env.repository";
import { isMaskedValue, isSensitiveEnvKey } from "../domain/core-env-secrets";

const ENV_LINE_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

// Aceita colar um .env inteiro de uma vez (linhas "CHAVE=valor", ignora
// comentários e linhas em branco) em vez de digitar variável por variável.
// Mesmo formato que upsertEnvValues já escreve, então um .env exportado por
// aqui e colado de volta funciona igual.
export function parseEnvText(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(ENV_LINE_PATTERN);
    if (match) {
      values[match[1]] = stripQuotes(match[2]);
    }
  }
  return values;
}

/**
 * Grava várias variáveis de ambiente do Core de uma vez.
 *
 * Valores que chegaram mascarados ("********") são ignorados para chaves
 * sensíveis: colar de volta um .env exportado pela tela de Configurações
 * não pode transformar a máscara no valor gravado (isso apagaria o
 * JWT_SECRET/ENV_ENCRYPTION_KEY do ambiente).
 */
@Injectable()
export class SetCoreEnvBulkUseCase {
  constructor(@Inject(CORE_ENV_REPOSITORY) private readonly envRepository: CoreEnvRepository) {}

  async execute(text: string): Promise<{ count: number; skipped: number }> {
    const parsed = parseEnvText(text);
    const parsedCount = Object.keys(parsed).length;
    if (parsedCount === 0) {
      throw new BadRequestException(
        apiError("ENV_BULK_EMPTY", "Nenhuma variável reconhecida. Use o formato CHAVE=valor, uma por linha."),
      );
    }

    const values: Record<string, string> = {};
    let skipped = 0;
    for (const [key, value] of Object.entries(parsed)) {
      if (isMaskedValue(value) && isSensitiveEnvKey(key)) {
        skipped += 1;
        continue;
      }
      values[key] = value;
    }

    const count = Object.keys(values).length;
    if (count > 0) {
      await this.envRepository.upsertMany(values);
    }
    return { count, skipped };
  }
}
