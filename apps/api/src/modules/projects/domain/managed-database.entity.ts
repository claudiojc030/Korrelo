export type DatabaseType = "postgres" | "redis" | "mongodb" | "custom";

export class ManagedDatabase {
  constructor(
    public readonly id: string,
    public readonly projectId: string,
    public readonly type: DatabaseType,
    // Nome do serviço/host dentro do docker-compose do projeto - "db" pro
    // primeiro banco gerenciado (compatibilidade com todo projeto criado
    // antes de existir suporte a mais de um), "db-<tipo>" pra qualquer banco
    // adicional. Null pra "custom" (não sobe container, não tem serviço).
    public readonly serviceName: string | null,
    public readonly username: string | null,
    public readonly password: string | null,
    public readonly databaseName: string | null,
    public readonly connectionString: string | null,
    public readonly envVarKey: string | null,
    // Só relevante pro Redis: Postgres/MongoDB sempre persistem em volume e
    // sempre entram no backup. Redis nasce efêmero (cache/fila) e só ganha
    // volume + entra no backup diário se isso for marcado explicitamente.
    public readonly persistent: boolean,
    public readonly createdAt: Date,
  ) {}

  static createManaged(
    projectId: string,
    type: "postgres" | "redis" | "mongodb",
    serviceName: string,
    password: string,
    persistent = false,
  ): ManagedDatabase {
    return new ManagedDatabase(
      crypto.randomUUID(),
      projectId,
      type,
      serviceName,
      "korrelo",
      password,
      "korrelo",
      null,
      null,
      type === "redis" ? persistent : true,
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
      null,
      connectionString,
      envVarKey,
      false,
      new Date(),
    );
  }
}

// Entre vários bancos do mesmo projeto, o "principal" é o mais antigo - é o
// que features que ainda só lidam com um banco por vez (navegador de dados,
// logs, backup manual) usam por padrão. Ordenar por createdAt em vez de
// depender de alguma flag garante que o comportamento de projeto com 1 banco
// só nunca muda, mesmo depois de virar multi-banco.
export function pickPrimaryDatabase(databases: ManagedDatabase[]): ManagedDatabase | undefined {
  return [...databases].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
}
