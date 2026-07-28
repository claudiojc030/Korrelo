export class User {
  constructor(
    public readonly id: string,
    public readonly email: string,
    public readonly passwordHash: string,
    public readonly createdAt: Date,
  ) {}

  static create(email: string, passwordHash: string): User {
    return new User(crypto.randomUUID(), email, passwordHash, new Date());
  }
}
