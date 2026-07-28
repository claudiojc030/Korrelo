import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { ManagedDatabase, type DatabaseType } from "../domain/managed-database.entity";
import type { ManagedDatabaseRepository } from "../domain/managed-database.repository";

@Injectable()
export class PrismaManagedDatabaseRepository implements ManagedDatabaseRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByProjectId(projectId: string): Promise<ManagedDatabase | null> {
    const row = await this.prisma.managedDatabase.findUnique({ where: { projectId } });
    return row ? this.toDomain(row) : null;
  }

  async save(db: ManagedDatabase): Promise<ManagedDatabase> {
    const row = await this.prisma.managedDatabase.upsert({
      where: { projectId: db.projectId },
      create: {
        id: db.id,
        projectId: db.projectId,
        type: db.type,
        username: db.username,
        password: db.password,
        databaseName: db.databaseName,
        connectionString: db.connectionString,
        envVarKey: db.envVarKey,
        persistent: db.persistent,
        createdAt: db.createdAt,
      },
      update: {
        type: db.type,
        username: db.username,
        password: db.password,
        databaseName: db.databaseName,
        connectionString: db.connectionString,
        envVarKey: db.envVarKey,
        persistent: db.persistent,
      },
    });
    return this.toDomain(row);
  }

  async delete(projectId: string): Promise<void> {
    await this.prisma.managedDatabase.deleteMany({ where: { projectId } });
  }

  private toDomain(row: {
    id: string;
    projectId: string;
    type: string;
    username: string | null;
    password: string | null;
    databaseName: string | null;
    connectionString: string | null;
    envVarKey: string | null;
    persistent: boolean;
    createdAt: Date;
  }): ManagedDatabase {
    return new ManagedDatabase(
      row.id,
      row.projectId,
      row.type as DatabaseType,
      row.username,
      row.password,
      row.databaseName,
      row.connectionString,
      row.envVarKey,
      row.persistent,
      row.createdAt,
    );
  }
}
