import type { RefreshToken } from "./refresh-token.entity";

export const REFRESH_TOKEN_REPOSITORY = Symbol("REFRESH_TOKEN_REPOSITORY");

export interface RefreshTokenRepository {
  findByTokenHash(tokenHash: string): Promise<RefreshToken | null>;
  findActiveByUserId(userId: string): Promise<RefreshToken[]>;
  findById(id: string): Promise<RefreshToken | null>;
  save(token: RefreshToken): Promise<RefreshToken>;
  // Update atomico condicionado a revokedAt ainda null. Sem isso, requisicoes
  // paralelas da mesma navegacao (varias sub-requisicoes do Next.js com o
  // mesmo cookie de refresh antigo) passam todas pelo isValid() antes de
  // qualquer uma commitar a revogacao, e cada uma cria seu proprio token novo
  // - so um vira o cookie real do navegador, os outros ficam orfaos, nunca
  // revogados, "ativos" pra sempre na lista de sessoes.
  revokeIfActive(id: string, replacedByTokenHash: string | null): Promise<boolean>;
}
