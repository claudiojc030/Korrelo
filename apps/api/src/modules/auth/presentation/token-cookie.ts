import type { CookieOptions } from "express";

export const TOKEN_COOKIE = "forgedesk_token";
const TOKEN_MAX_AGE_MS = 12 * 60 * 60 * 1000;

// req.secure só é true quando o Express confia no proxy (ver app.set("trust proxy", ...)
// em main.ts) e o nginx na frente manda X-Forwarded-Proto: https.
export function buildTokenCookieOptions(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: TOKEN_MAX_AGE_MS,
  };
}
