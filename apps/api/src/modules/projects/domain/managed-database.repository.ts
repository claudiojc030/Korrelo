import type { DatabaseType, ManagedDatabase } from "./managed-database.entity";

export const MANAGED_DATABASE_REPOSITORY = Symbol("MANAGED_DATABASE_REPOSITORY");

export interface ManagedDatabaseRepository {
  findAllByProjectId(projectId: string): Promise<ManagedDatabase[]>;
  save(db: ManagedDatabase): Promise<ManagedDatabase>;
  delete(projectId: string, type: DatabaseType): Promise<void>;
}
