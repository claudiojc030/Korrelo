export class GithubInstallation {
  constructor(
    public readonly id: string,
    public readonly installationId: number,
    public readonly accountLogin: string,
    public readonly createdAt: Date,
  ) {}

  static create(installationId: number, accountLogin: string): GithubInstallation {
    return new GithubInstallation(crypto.randomUUID(), installationId, accountLogin, new Date());
  }
}
