import { Inject, Injectable } from "@nestjs/common";
import { TOKEN_SERVICE, type TokenService } from "../domain/token-service";
import { REFRESH_TOKEN_REPOSITORY, type RefreshTokenRepository } from "../domain/refresh-token.repository";
import { RefreshToken } from "../domain/refresh-token.entity";
import { generateRefreshToken, hashRefreshToken, REFRESH_TOKEN_TTL_DAYS } from "../infrastructure/refresh-token-crypto";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

// Emite o par access+refresh, usado por login, registro do primeiro usuário,
// e pela rotação de refresh token. Fica num serviço à parte (não num use case
// isolado) porque não é um endpoint em si, é uma etapa compartilhada por três
// fluxos diferentes.
@Injectable()
export class TokenPairIssuer {
  constructor(
    @Inject(TOKEN_SERVICE) private readonly tokenService: TokenService,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokenRepository: RefreshTokenRepository,
  ) {}

  async issue(
    userId: string,
    username: string,
    userAgent: string | null = null,
    ipAddress: string | null = null,
  ): Promise<TokenPair> {
    const accessToken = this.tokenService.sign({ sub: userId, username });

    const refreshToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    await this.refreshTokenRepository.save(
      RefreshToken.create(userId, hashRefreshToken(refreshToken), expiresAt, userAgent, ipAddress),
    );

    return { accessToken, refreshToken };
  }
}
