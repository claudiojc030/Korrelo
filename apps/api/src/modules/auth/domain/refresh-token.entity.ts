export class RefreshToken {
  constructor(
    public readonly id: string,
    public readonly userId: string,
    public readonly tokenHash: string,
    public readonly userAgent: string | null,
    public readonly ipAddress: string | null,
    public readonly expiresAt: Date,
    public readonly revokedAt: Date | null,
    public readonly replacedByTokenHash: string | null,
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
    return new RefreshToken(crypto.randomUUID(), userId, tokenHash, userAgent, ipAddress, expiresAt, null, null, now, now);
  }

  isValid(): boolean {
    return this.revokedAt === null && this.expiresAt.getTime() > Date.now();
  }

  // Curto o suficiente pra não abrir brecha real de segurança (só dá um
  // access token novo, nunca outro refresh token), longo o suficiente pra
  // cobrir a corrida de requisições paralelas do Next.js na mesma navegação.
  private static readonly REUSE_GRACE_MS = 15_000;

  wasJustReplacedWithinGrace(): boolean {
    return this.revokedAt !== null && Date.now() - this.revokedAt.getTime() < RefreshToken.REUSE_GRACE_MS;
  }

  revoke(replacedByTokenHash: string | null = null): RefreshToken {
    return new RefreshToken(
      this.id,
      this.userId,
      this.tokenHash,
      this.userAgent,
      this.ipAddress,
      this.expiresAt,
      new Date(),
      replacedByTokenHash,
      this.lastUsedAt,
      this.createdAt,
    );
  }
}
