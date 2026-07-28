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

  async findById(id: string): Promise<RefreshToken | null> {
    const row = await this.prisma.refreshToken.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  async findActiveByUserId(userId: string): Promise<RefreshToken[]> {
    const rows = await this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: "desc" },
    });
    return rows.map((row) => this.toDomain(row));
  }

  async save(token: RefreshToken): Promise<RefreshToken> {
    const row = await this.prisma.refreshToken.upsert({
      where: { id: token.id },
      create: {
        id: token.id,
        userId: token.userId,
        tokenHash: token.tokenHash,
        userAgent: token.userAgent,
        ipAddress: token.ipAddress,
        expiresAt: token.expiresAt,
        revokedAt: token.revokedAt,
        lastUsedAt: token.lastUsedAt,
        createdAt: token.createdAt,
      },
      update: {
        revokedAt: token.revokedAt,
        lastUsedAt: token.lastUsedAt,
      },
    });
    return this.toDomain(row);
  }

  private toDomain(row: {
    id: string;
    userId: string;
    tokenHash: string;
    userAgent: string | null;
    ipAddress: string | null;
    expiresAt: Date;
    revokedAt: Date | null;
    lastUsedAt: Date;
    createdAt: Date;
  }): RefreshToken {
    return new RefreshToken(
      row.id,
      row.userId,
      row.tokenHash,
      row.userAgent,
      row.ipAddress,
      row.expiresAt,
      row.revokedAt,
      row.lastUsedAt,
      row.createdAt,
    );
  }
}
