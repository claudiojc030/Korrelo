// Nome do cookie httpOnly de auth, setado/limpo pela API (login/register/logout),
// nunca por JS no navegador. Exportado aqui só pra middleware.ts checar presença.
export const TOKEN_COOKIE = "forgedesk_token";
