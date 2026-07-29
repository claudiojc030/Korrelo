import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { USER_REPOSITORY, type UserRepository } from "../domain/user.repository";
import { REFRESH_TOKEN_REPOSITORY, type RefreshTokenRepository } from "../domain/refresh-token.repository";
import { hashRefreshToken } from "../infrastructure/refresh-token-crypto";
import { TokenPairIssuer, type TokenPair } from "./token-pair-issuer";

@Injectable()
export class RefreshAccessTokenUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly userRepository: UserRepository,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokenRepository: RefreshTokenRepository,
    private readonly tokenPairIssuer: TokenPairIssuer,
  ) {}

  async execute(
    rawToken: string,
    userAgent: string | null = null,
    ipAddress: string | null = null,
  ): Promise<TokenPair & { email: string }> {
    const stored = await this.refreshTokenRepository.findByTokenHash(hashRefreshToken(rawToken));
    if (!stored || !stored.isValid()) {
      throw new UnauthorizedException(apiError("SESSION_EXPIRED", "Sessão expirada. Faça login novamente."));
    }

    const user = await this.userRepository.findById(stored.userId);
    if (!user) {
      throw new UnauthorizedException(apiError("SESSION_EXPIRED", "Sessão expirada. Faça login novamente."));
    }

    // Rotação: o token usado é revogado antes de emitir o novo par, então
    // reuso de um refresh token antigo (ex.: token roubado já consumido pelo
    // dono legítimo) é detectado e rejeitado na próxima tentativa.
    await this.refreshTokenRepository.save(stored.revoke());

    const { accessToken, refreshToken } = await this.tokenPairIssuer.issue(
      user.id,
      user.email,
      userAgent ?? stored.userAgent,
      ipAddress ?? stored.ipAddress,
    );
    return { accessToken, refreshToken, email: user.email };
  }
}
