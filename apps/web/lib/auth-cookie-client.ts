// Nome dos cookies httpOnly de auth, setados/limpos pela API (login/register/logout),
// nunca por JS no navegador. Exportados aqui só pro proxy.ts (middleware) checar
// presença e, se precisar, renovar o access token via refresh token.
export const TOKEN_COOKIE = "korrelo_token";
export const REFRESH_TOKEN_COOKIE = "korrelo_refresh_token";
