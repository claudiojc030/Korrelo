import type { ManagedDatabase } from "./managed-database.entity";

export const MANAGED_DATABASE_REPOSITORY = Symbol("MANAGED_DATABASE_REPOSITORY");

export interface ManagedDatabaseRepository {
  findByProjectId(projectId: string): Promise<ManagedDatabase | null>;
  save(db: ManagedDatabase): Promise<ManagedDatabase>;
  delete(projectId: string): Promise<void>;
}
