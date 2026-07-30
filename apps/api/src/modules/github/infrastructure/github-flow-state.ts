import { InternalServerErrorException } from "@nestjs/common";
import jwt from "jsonwebtoken";
import { apiError } from "../../../infrastructure/api-error";

const STATE_TTL = "10m";

function jwtSecret(): string {
  const value = process.env.JWT_SECRET;
  if (!value) throw new InternalServerErrorException(apiError("JWT_SECRET_MISSING", "JWT_SECRET não configurado"));
  return value;
}

// Prova de que quem está completando um fluxo de redirect do GitHub (criação
// de App via manifest, ou instalação de App) é a mesma sessão autenticada que
// iniciou ele. O cookie de sessão sozinho NÃO basta pra provar isso: sendo
// SameSite=Lax, ele é enviado em qualquer navegação de topo, inclusive um
// link forjado por um atacante que a pessoa clique estando logada, não só em
// redirects que vieram de verdade do github.com. Como esse "state" só é
// emitido por uma rota autenticada, um atacante nunca consegue forjar um
// válido, então um link malicioso não passa na verificação.
export function signGithubFlowState(purpose: string): string {
  return jwt.sign({ purpose }, jwtSecret(), { expiresIn: STATE_TTL });
}

export function verifyGithubFlowState(state: string | undefined, purpose: string): boolean {
  if (!state) return false;
  try {
    const payload = jwt.verify(state, jwtSecret()) as { purpose?: string };
    return payload.purpose === purpose;
  } catch {
    return false;
  }
}
