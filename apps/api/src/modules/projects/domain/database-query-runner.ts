import type { ManagedDatabase } from "./managed-database.entity";

export const DATABASE_QUERY_RUNNER = Symbol("DATABASE_QUERY_RUNNER");

export interface DatabaseQueryResult {
  columns: string[];
  rows: string[][];
  rowCount: number;
  notice: string | null;
}

export interface DatabaseQueryRunner {
  listTables(containerName: string, database: ManagedDatabase): Promise<string[]>;
  runQuery(containerName: string, database: ManagedDatabase, query: string): Promise<DatabaseQueryResult>;
  // "table" é uma tabela (postgres) ou coleção (mongodb) - usado só pela edição
  // inline do navegador de dados, pra saber qual coluna identifica a linha.
  getPrimaryKeyColumns(containerName: string, database: ManagedDatabase, table: string): Promise<string[]>;
  updateRow(
    containerName: string,
    database: ManagedDatabase,
    table: string,
    primaryKey: Record<string, string>,
    changes: Record<string, string>,
  ): Promise<void>;
}
