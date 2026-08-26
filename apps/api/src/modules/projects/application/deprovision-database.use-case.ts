import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import {
  MANAGED_DATABASE_REPOSITORY,
  type ManagedDatabaseRepository,
} from "../domain/managed-database.repository";
import type { DatabaseType } from "../domain/managed-database.entity";

@Injectable()
export class DeprovisionDatabaseUseCase {
  constructor(
    @Inject(MANAGED_DATABASE_REPOSITORY) private readonly databaseRepository: ManagedDatabaseRepository,
  ) {}

  async execute(projectId: string, type: DatabaseType): Promise<void> {
    const existing = await this.databaseRepository.findAllByProjectId(projectId);
    if (!existing.some((db) => db.type === type)) {
      throw new NotFoundException(apiError("DATABASE_NOT_PROVISIONED", "Este projeto não tem esse banco de dados provisionado."));
    }
    await this.databaseRepository.delete(projectId, type);
    // A variável de ambiente (DATABASE_URL/REDIS_URL) fica órfã de propósito.
    // Apagá-la também poderia quebrar algo que o usuário setou manualmente por cima.
    // O container do banco some no próximo deploy graças ao --remove-orphans.
  }
}
