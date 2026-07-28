export class RefreshToken {
  constructor(
    public readonly id: string,
    public readonly userId: string,
    public readonly tokenHash: string,
    public readonly expiresAt: Date,
    public readonly revokedAt: Date | null,
    public readonly createdAt: Date,
  ) {}

  static create(userId: string, tokenHash: string, expiresAt: Date): RefreshToken {
    return new RefreshToken(crypto.randomUUID(), userId, tokenHash, expiresAt, null, new Date());
  }

  isValid(): boolean {
    return this.revokedAt === null && this.expiresAt.getTime() > Date.now();
  }

  revoke(): RefreshToken {
    return new RefreshToken(this.id, this.userId, this.tokenHash, this.expiresAt, new Date(), this.createdAt);
  }
}
