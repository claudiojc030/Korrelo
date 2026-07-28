import { Inject, Injectable } from "@nestjs/common";
import { REFRESH_TOKEN_REPOSITORY, type RefreshTokenRepository } from "../domain/refresh-token.repository";
import { hashRefreshToken } from "../infrastructure/refresh-token-crypto";

export interface ActiveSession {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  isCurrent: boolean;
}

@Injectable()
export class ListActiveSessionsUseCase {
  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokenRepository: RefreshTokenRepository,
  ) {}

  async execute(userId: string, currentRawToken: string | undefined): Promise<ActiveSession[]> {
    const currentHash = currentRawToken ? hashRefreshToken(currentRawToken) : null;
    const sessions = await this.refreshTokenRepository.findActiveByUserId(userId);

    return sessions.map((session) => ({
      id: session.id,
      userAgent: session.userAgent,
      ipAddress: session.ipAddress,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      expiresAt: session.expiresAt,
      isCurrent: currentHash !== null && session.tokenHash === currentHash,
    }));
  }
}
