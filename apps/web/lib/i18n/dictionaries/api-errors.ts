export type ApiErrorsDict = Record<string, string>;

export const apiErrorsEn: ApiErrorsDict = {
  INVALID_CREDENTIALS: "Invalid username or password.",
  INVALID_TWO_FACTOR_CODE: "Invalid verification code.",
  ACCOUNT_ALREADY_EXISTS: "There's already an account set up on this Korrelo. Use /auth/login.",
  USER_NOT_FOUND: "User not found.",
  TWO_FACTOR_ALREADY_ENABLED: "2FA is already enabled on this account. Disable it before reconfiguring.",
  TWO_FACTOR_SETUP_NOT_PENDING: "No pending 2FA setup. Call /auth/2fa/setup first.",
  TWO_FACTOR_NOT_ENABLED: "2FA isn't enabled on this account.",
  INCORRECT_PASSWORD: "Incorrect password.",
  SESSION_NOT_FOUND: "Session not found.",
  SESSION_NOT_OWNED: "This session doesn't belong to this account.",
  SESSION_EXPIRED: "Session expired. Please sign in again.",
  ACCESS_TOKEN_MISSING: "Missing access token.",
  ACCESS_TOKEN_INVALID: "Invalid or expired access token.",
  JWT_SECRET_MISSING: "Server misconfiguration (JWT_SECRET not set).",
};

export const apiErrorsPt: ApiErrorsDict = {
  INVALID_CREDENTIALS: "Usuário ou senha inválidos.",
  INVALID_TWO_FACTOR_CODE: "Código de verificação inválido.",
  ACCOUNT_ALREADY_EXISTS: "Já existe uma conta configurada neste Korrelo. Use /auth/login.",
  USER_NOT_FOUND: "Usuário não encontrado.",
  TWO_FACTOR_ALREADY_ENABLED: "2FA já está ativado nesta conta. Desative antes de reconfigurar.",
  TWO_FACTOR_SETUP_NOT_PENDING: "Nenhuma configuração de 2FA pendente. Chame /auth/2fa/setup primeiro.",
  TWO_FACTOR_NOT_ENABLED: "2FA não está ativado nesta conta.",
  INCORRECT_PASSWORD: "Senha incorreta.",
  SESSION_NOT_FOUND: "Sessão não encontrada.",
  SESSION_NOT_OWNED: "Essa sessão não pertence a esta conta.",
  SESSION_EXPIRED: "Sessão expirada. Faça login novamente.",
  ACCESS_TOKEN_MISSING: "Token de acesso ausente.",
  ACCESS_TOKEN_INVALID: "Token de acesso inválido ou expirado.",
  JWT_SECRET_MISSING: "Erro de configuração do servidor (JWT_SECRET ausente).",
};
