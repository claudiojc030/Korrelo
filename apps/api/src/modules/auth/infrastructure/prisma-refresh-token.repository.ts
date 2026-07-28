import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { RefreshToken } from "../domain/refresh-token.entity";
import type { RefreshTokenRepository } from "../domain/refresh-token.repository";

@Injectable()
export class PrismaRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByTokenHash(tokenHash: string): Promise<RefreshToken | null> {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    return row ? this.toDomain(row) : null;
  }

  async save(token: RefreshToken): Promise<RefreshToken> {
    const row = await this.prisma.refreshToken.upsert({
      where: { id: token.id },
      create: {
        id: token.id,
        userId: token.userId,
        tokenHash: token.tokenHash,
        expiresAt: token.expiresAt,
        revokedAt: token.revokedAt,
        createdAt: token.createdAt,
      },
      update: {
        revokedAt: token.revokedAt,
      },
    });
    return this.toDomain(row);
  }

  private toDomain(row: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    revokedAt: Date | null;
    createdAt: Date;
  }): RefreshToken {
    return new RefreshToken(row.id, row.userId, row.tokenHash, row.expiresAt, row.revokedAt, row.createdAt);
  }
}
