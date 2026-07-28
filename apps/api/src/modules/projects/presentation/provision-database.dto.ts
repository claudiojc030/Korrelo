import type { DatabaseType } from "../domain/managed-database.entity";

export class ProvisionDatabaseDto {
  type!: DatabaseType;
  connectionString?: string;
  envVarKey?: string;
  persistRedis?: boolean;
}
