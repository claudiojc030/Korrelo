export class User {
  constructor(
    public readonly id: string,
    public readonly username: string,
    public readonly passwordHash: string,
    public readonly twoFactorSecret: string | null,
    public readonly twoFactorEnabled: boolean,
    public readonly twoFactorBackupCodes: string[],
    public readonly createdAt: Date,
  ) {}

  static create(username: string, passwordHash: string): User {
    return new User(crypto.randomUUID(), username, passwordHash, null, false, [], new Date());
  }

  withPendingTwoFactorSecret(secret: string): User {
    return new User(this.id, this.username, this.passwordHash, secret, false, [], this.createdAt);
  }

  withTwoFactorEnabled(backupCodeHashes: string[]): User {
    return new User(this.id, this.username, this.passwordHash, this.twoFactorSecret, true, backupCodeHashes, this.createdAt);
  }

  withTwoFactorDisabled(): User {
    return new User(this.id, this.username, this.passwordHash, null, false, [], this.createdAt);
  }

  withBackupCodes(backupCodeHashes: string[]): User {
    return new User(
      this.id,
      this.username,
      this.passwordHash,
      this.twoFactorSecret,
      this.twoFactorEnabled,
      backupCodeHashes,
      this.createdAt,
    );
  }
}
