/**
 * RESOLUÇÃO OFICIAL DA CREDENCIAL DO BANCO GERENCIADO.
 *
 * A senha (e a connection string) do banco gerenciado ficam CIFRADAS em
 * repouso no banco do Core (ver EnvVarCipher). Quem LÊ o banco pelo
 * caminho oficial (a API, via PrismaManagedDatabaseRepository) descriptografa
 * antes de usar.
 *
 * O backup diario (apps/api/scripts/backup.js) lia o Prisma direto e,
 * sem descriptografar, passava a senha CIFRADA pro mongodump - o backup
 * falhava com AuthenticationFailed/SCRAM-SHA-256 (e a senha cifrada
 * ainda ia parar no argv do mongodump).
 *
 * Esta funcao e o UNICO lugar que normaliza a credencial, para que o
 * caminho manual (API) e o caminho do cron usem exatamente a mesma regra.
 */
export interface CredentialDecryptor {
  decrypt(value: string): string;
}

/**
 * Devolve a credencial em texto puro (em memoria).
 *
 * - valor ausente (null/undefined/""): devolve como esta (sem erro);
 * - valor legado (sem o prefixo "enc:v1:"): o cipher devolve como esta;
 * - valor cifrado: o cipher descriptografa; se falhar, o erro sobe (falha
 *   fechada - o backup NAO continua com credencial invalida).
 *
 * O valor descriptografado existe so em memoria: nao vai para log, nem
 * para manifesto, nem para arquivo.
 */
export function resolveDatabaseCredential(
  stored: string | null | undefined,
  cipher: CredentialDecryptor,
): string | null {
  if (!stored) return null;
  return cipher.decrypt(stored);
}

/** Banco gerenciado com credencial (cifrada ou legada). */
export interface ManagedDatabaseCredentialRow {
  password?: string | null;
  connectionString?: string | null;
  [key: string]: unknown;
}

/** Projeto com a lista de bancos gerenciados (o formato do Prisma). */
export interface ProjectWithManagedDatabases {
  managedDatabases?: ManagedDatabaseCredentialRow[];
  [key: string]: unknown;
}

/**
 * Descriptografa as credenciais dos bancos gerenciados de uma lista de
 * PROJETOS (formato do Prisma: projeto -> managedDatabases[]).
 *
 * Usado pelo caminho MANUAL (a API le pelo repositorio) e pelo caminho do
 * CRON (apps/api/scripts/backup.js le o Prisma direto) - assim os dois
 * normalizam a credencial exatamente do mesmo jeito.
 */
export function decryptManagedDatabaseCredentials<T extends ProjectWithManagedDatabases>(
  projects: T[],
  cipher: CredentialDecryptor,
): T[] {
  return projects.map((project) => ({
    ...project,
    managedDatabases: (project.managedDatabases || []).map((db) => ({
      ...db,
      password: resolveDatabaseCredential(db.password, cipher),
      connectionString: resolveDatabaseCredential(db.connectionString, cipher),
    })),
  }));
}
