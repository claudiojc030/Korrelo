/**
 * Regras de sigilo das variáveis de ambiente do Core.
 *
 * O `GET /settings/env` devolvia o `.env` INTEIRO (JWT_SECRET,
 * ENV_ENCRYPTION_KEY, chave privada do GitHub App, DATABASE_URL com senha)
 * pra qualquer sessão autenticada. Isso transformava um XSS, uma extensão
 * maliciosa ou uma sessão vazada em comprometimento total do Core - e de
 * quebra o ambiente inteiro, porque o mesmo `.env` autentica o GitHub App.
 *
 * Regras:
 * - Variável sensível NUNCA volta com o valor real em resposta comum.
 * - O valor mascarado é um sentinel fixo: se o cliente mandar ele de volta
 *   numa gravação, o backend entende "não mexe no que está gravado".
 * - A máscara é constante (sem prefixo do valor real): não vaza tamanho nem
 *   começo do segredo.
 */

/** Valor devolvido no lugar de um segredo. Nunca é um valor real. */
export const SECRET_MASK = "********";

/**
 * Padrões de nome de variável considered sensíveis. Casados sem diferenciar
 * maiúsculas/minúsculas.
 */
const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /SECRET/,
  /TOKEN/,
  /PASSWORD/,
  /PASSWD/,
  /PRIVATE/,
  /API[_-]?KEY/,
  /ACCESS[_-]?KEY/,
  /CREDENTIAL/,
  /ENCRYPTION/,
  /_KEY$/,
  /_URI$/,
  /^DATABASE_URL$/,
  /^REDIS_URL$/,
  /^WEBHOOK/,
  /NTFY_TOPIC/,
];

/** true quando o valor dessa variável não deve ser exposto em resposta comum. */
export function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/** Devolve o valor mascarado para chaves sensíveis e o valor real nas outras. */
export function maskEnvValue(key: string, value: string): string {
  return isSensitiveEnvKey(key) ? SECRET_MASK : value;
}

/**
 * true quando o valor recebido é a máscara (ou seja, "não altere isso").
 * Usado na gravação pra nunca sobrescrever um segredo com a própria máscara.
 */
export function isMaskedValue(value: string): boolean {
  return value === SECRET_MASK;
}
