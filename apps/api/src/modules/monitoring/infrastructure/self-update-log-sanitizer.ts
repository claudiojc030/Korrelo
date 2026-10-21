/**
 * SANITIZAÇÃO DO LOG DO SELF-UPDATE (backend).
 *
 * O log do runner é lido do arquivo (~/.korrelo/self-update/<id>.log) e
 * entregue para a UI. Ele NÃO deveria conter segredo nenhum (é a saída do
 * próprio rollout do Core), mas:
 *
 * - o rollout pode imprimir a saída de uma ferramenta que ecoa uma URL com
 *   credencial, ou o ambiente de um subcomando;
 * - a UI não é o único consumidor da API (o endpoint /self-update/:id/log
 *   pode ser lido por qualquer pessoa autenticada).
 *
 * Por isso a limpeza acontece AQUI, no backend, ANTES do log/status sair
 * em direção ao frontend. A view tem um filtro próprio (defesa em
 * profundidade), mas o dado que sai da API já vem limpo.
 *
 * O QUE É PRESERVADO: o texto do rollout, as medições de recurso (swap,
 * load, MemAvailable) e as mensagens de estágio - é isso que o operador
 * precisa ver. O QUE É REMOVIDO: valores de variável de ambiente
 * sensíveis, tokens, senhas, chaves privadas e connection strings.
 */

/** Nome de variável de ambiente cujo VALOR nunca pode aparecer. */
const SENSITIVE_ENV_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|AUTH)/i;

/** Valor de env sensível só é mascarado se for grande o bastante pra ser ele. */
const MIN_ENV_VALUE_LENGTH = 8;

/** Padrões que carregam o segredo INTEIRO. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  // Bearer / tokens
  /\bBearer\s+[A-Za-z0-9._-]{8,}[^\n]*/g,
  // chave privada PEM (multilinha)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // connection string com credencial embutida
  /\b(mongodb(?:\+srv)?|postgres(?:ql)?|redis):\/\/[^\s"']+:\S+@[^\s"']+/gi,
];

/** Padrões "chave=valor" / "chave: valor" onde a CHAVE parece um segredo. */
const SECRET_KEY_PATTERNS: RegExp[] = [
  /((?:SECRET|TOKEN|PASSWORD|PASSWD|PASS|CREDENTIAL|PRIVATE_KEY|API_KEY|AUTH|COOKIE|SESSION)[A-Z_]*)\s*=\s*\S+/gi,
  /((?:SECRET|TOKEN|PASSWORD|PASSWD|PASS|CREDENTIAL|PRIVATE_KEY|API_KEY|AUTH|COOKIE|SESSION)[A-Z_]*)\s*:[^\n]*/gi,
  /\b(senha|password|token|secret|chave|credencial)\s*:[^\n]*/gi,
];

/**
 * Mascara os valores das variáveis de ambiente sensíveis que aparecerem no
 * texto (o runner já faz isso no failureReason - aqui é defesa em
 * profundidade para o log inteiro).
 */
export function maskEnvValues(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let output = text;
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value !== "string" || value.length < MIN_ENV_VALUE_LENGTH) continue;
    if (!SENSITIVE_ENV_NAME.test(key)) continue;
    output = output.split(value).join("***");
  }
  return output;
}

/**
 * Sanitiza o log do self-update para exibição.
 *
 * Idempotente: sanitizar duas vezes dá o mesmo resultado.
 */
export function sanitizeSelfUpdateLog(log: string, env: NodeJS.ProcessEnv = process.env): string {
  let text = String(log ?? "");
  for (const pattern of SECRET_VALUE_PATTERNS) {
    text = text.replace(pattern, "***");
  }
  for (const pattern of SECRET_KEY_PATTERNS) {
    text = text.replace(pattern, (match) => {
      const separator = match.includes("=") ? "=" : ":";
      const key = match.split(separator)[0];
      return `${key}${separator}***`;
    });
  }
  return maskEnvValues(text, env);
}
