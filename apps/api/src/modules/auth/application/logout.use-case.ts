import { Inject, Injectable } from "@nestjs/common";
import { REFRESH_TOKEN_REPOSITORY, type RefreshTokenRepository } from "../domain/refresh-token.repository";
import { hashRefreshToken } from "../infrastructure/refresh-token-crypto";

@Injectable()
export class LogoutUseCase {
  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokenRepository: RefreshTokenRepository,
  ) {}

  async execute(rawToken: string | undefined): Promise<void> {
    if (!rawToken) {
      return;
    }

    const stored = await this.refreshTokenRepository.findByTokenHash(hashRefreshToken(rawToken));
    if (stored && stored.revokedAt === null) {
      await this.refreshTokenRepository.save(stored.revoke());
    }
  }
}
