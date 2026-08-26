import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { EnvVarCipher } from "../../../infrastructure/crypto/env-var-cipher";
import { ManagedDatabase, type DatabaseType } from "../domain/managed-database.entity";
import type { ManagedDatabaseRepository } from "../domain/managed-database.repository";

@Injectable()
export class PrismaManagedDatabaseRepository implements ManagedDatabaseRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: EnvVarCipher,
  ) {}

  async findAllByProjectId(projectId: string): Promise<ManagedDatabase[]> {
    const rows = await this.prisma.managedDatabase.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
    return rows.map((row) => this.toDomain(row));
  }

  async save(db: ManagedDatabase): Promise<ManagedDatabase> {
    // Senha do banco gerenciado e connection string externa ("custom") são
    // segredos de verdade tanto quanto env vars de projeto - cifradas em
    // repouso pelo mesmo motivo (ver EnvVarCipher).
    const password = db.password ? this.cipher.encrypt(db.password) : db.password;
    const connectionString = db.connectionString ? this.cipher.encrypt(db.connectionString) : db.connectionString;
    const row = await this.prisma.managedDatabase.upsert({
      where: { projectId_type: { projectId: db.projectId, type: db.type } },
      create: {
        id: db.id,
        projectId: db.projectId,
        type: db.type,
        serviceName: db.serviceName,
        username: db.username,
        password,
        databaseName: db.databaseName,
        connectionString,
        envVarKey: db.envVarKey,
        persistent: db.persistent,
        createdAt: db.createdAt,
      },
      update: {
        serviceName: db.serviceName,
        username: db.username,
        password,
        databaseName: db.databaseName,
        connectionString,
        envVarKey: db.envVarKey,
        persistent: db.persistent,
      },
    });
    return this.toDomain(row);
  }

  async delete(projectId: string, type: DatabaseType): Promise<void> {
    await this.prisma.managedDatabase.deleteMany({ where: { projectId, type } });
  }

  private toDomain(row: {
    id: string;
    projectId: string;
    type: string;
    serviceName: string | null;
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
      row.serviceName,
      row.username,
      row.password ? this.cipher.decrypt(row.password) : row.password,
      row.databaseName,
      row.connectionString ? this.cipher.decrypt(row.connectionString) : row.connectionString,
      row.envVarKey,
      row.persistent,
      row.createdAt,
    );
  }
}
