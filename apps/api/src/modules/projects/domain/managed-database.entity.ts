export type DatabaseType = "postgres" | "redis" | "mongodb" | "custom";

export class ManagedDatabase {
  constructor(
    public readonly id: string,
    public readonly projectId: string,
    public readonly type: DatabaseType,
    public readonly username: string | null,
    public readonly password: string | null,
    public readonly databaseName: string | null,
    public readonly connectionString: string | null,
    public readonly envVarKey: string | null,
    public readonly createdAt: Date,
  ) {}

  static createManaged(projectId: string, type: "postgres" | "redis" | "mongodb", password: string): ManagedDatabase {
    return new ManagedDatabase(
      crypto.randomUUID(),
      projectId,
      type,
      "forgedesk",
      password,
      "forgedesk",
      null,
      null,
      new Date(),
    );
  }

  static createCustom(projectId: string, connectionString: string, envVarKey: string): ManagedDatabase {
    return new ManagedDatabase(
      crypto.randomUUID(),
      projectId,
      "custom",
      null,
      null,
      null,
      connectionString,
      envVarKey,
      new Date(),
    );
  }
}
