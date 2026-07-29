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

// Path restrito a /auth: o navegador só manda esse cookie pras rotas de auth
// (refresh/logout), nunca em toda requisição. Isso reduz a exposição do segredo
// de longa duração mesmo sendo httpOnly.
export function buildRefreshTokenCookieOptions(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/auth",
    maxAge: REFRESH_TOKEN_MAX_AGE_MS,
  };
}
