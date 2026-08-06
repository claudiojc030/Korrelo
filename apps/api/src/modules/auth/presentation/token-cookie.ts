import type { CookieOptions } from "express";
import { REFRESH_TOKEN_TTL_DAYS } from "../infrastructure/refresh-token-crypto";

export const TOKEN_COOKIE = "korrelo_token";
export const REFRESH_TOKEN_COOKIE = "korrelo_refresh_token";
const ACCESS_TOKEN_MAX_AGE_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_MAX_AGE_MS = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

// req.secure só é true quando o Express confia no proxy (ver app.set("trust proxy", ...)
// em main.ts) e o nginx na frente manda X-Forwarded-Proto: https.
export function buildTokenCookieOptions(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: ACCESS_TOKEN_MAX_AGE_MS,
  };
}

// Path "/" (não só "/auth"): o proxy.ts do Next.js precisa desse cookie em
// QUALQUER navegação de página pra renovar a sessão sozinho quando o access
// token expira (15min de inatividade). Com path restrito a "/auth" o
// navegador nunca mandava esse cookie numa navegação normal (ex.: /dashboard),
// só em chamadas de API que batem direto em /auth/*  então a renovação
// silenciosa nunca funcionava de verdade e o usuário caía pro login.
export function buildRefreshTokenCookieOptions(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: REFRESH_TOKEN_MAX_AGE_MS,
  };
}
