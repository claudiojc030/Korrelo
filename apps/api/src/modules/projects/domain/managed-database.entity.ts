export type DatabaseType = "postgres" | "redis";

export class ManagedDatabase {
  constructor(
    public readonly id: string,
    public readonly projectId: string,
    public readonly type: DatabaseType,
    public readonly username: string,
    public readonly password: string,
    public readonly databaseName: string,
    public readonly createdAt: Date,
  ) {}

  static create(projectId: string, type: DatabaseType, password: string): ManagedDatabase {
    return new ManagedDatabase(
      crypto.randomUUID(),
      projectId,
      type,
      "forgedesk",
      password,
      "forgedesk",
      new Date(),
    );
  }
}
