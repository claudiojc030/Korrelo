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
}
