import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  MANAGED_DATABASE_REPOSITORY,
  type ManagedDatabaseRepository,
} from "../domain/managed-database.repository";

@Injectable()
export class DeprovisionDatabaseUseCase {
  constructor(
    @Inject(MANAGED_DATABASE_REPOSITORY) private readonly databaseRepository: ManagedDatabaseRepository,
  ) {}

  async execute(projectId: string): Promise<void> {
    const existing = await this.databaseRepository.findByProjectId(projectId);
    if (!existing) {
      throw new NotFoundException("Este projeto não tem banco de dados provisionado.");
    }
    await this.databaseRepository.delete(projectId);
    // A variável de ambiente (DATABASE_URL/REDIS_URL) fica órfã de propósito.
    // Apagá-la também poderia quebrar algo que o usuário setou manualmente por cima.
    // O container do banco some no próximo deploy graças ao --remove-orphans.
  }
}
