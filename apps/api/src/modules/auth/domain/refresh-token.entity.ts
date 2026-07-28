export class RefreshToken {
  constructor(
    public readonly id: string,
    public readonly userId: string,
    public readonly tokenHash: string,
    public readonly userAgent: string | null,
    public readonly ipAddress: string | null,
    public readonly expiresAt: Date,
    public readonly revokedAt: Date | null,
    public readonly lastUsedAt: Date,
    public readonly createdAt: Date,
  ) {}

  static create(
    userId: string,
    tokenHash: string,
    expiresAt: Date,
    userAgent: string | null = null,
    ipAddress: string | null = null,
  ): RefreshToken {
    const now = new Date();
    return new RefreshToken(crypto.randomUUID(), userId, tokenHash, userAgent, ipAddress, expiresAt, null, now, now);
  }

  isValid(): boolean {
    return this.revokedAt === null && this.expiresAt.getTime() > Date.now();
  }

  revoke(): RefreshToken {
    return new RefreshToken(
      this.id,
      this.userId,
      this.tokenHash,
      this.userAgent,
      this.ipAddress,
      this.expiresAt,
      new Date(),
      this.lastUsedAt,
      this.createdAt,
    );
  }
}
