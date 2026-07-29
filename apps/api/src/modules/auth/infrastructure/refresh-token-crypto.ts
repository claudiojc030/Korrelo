import * as crypto from "node:crypto";

export const REFRESH_TOKEN_TTL_DAYS = 30;

export function generateRefreshToken(): string {
  return crypto.randomBytes(48).toString("hex");
}

// Refresh token é uma string aleatória de alta entropia (384 bits), não uma
// senha escolhida por humano, então SHA-256 (rápido) é apropriado aqui pra permitir
// lookup direto no banco; bcrypt (lento, pensado pra resistir brute-force de
// segredo de baixa entropia) não faria sentido e não escalaria pra essa busca.
export function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
