import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import {
  MANAGED_DATABASE_REPOSITORY,
  type ManagedDatabaseRepository,
} from "../domain/managed-database.repository";
import { pickPrimaryDatabase } from "../domain/managed-database.entity";
import { DATABASE_QUERY_RUNNER, type DatabaseQueryRunner } from "../domain/database-query-runner";

export interface RowUpdateInput {
  primaryKey: Record<string, string>;
  changes: Record<string, string>;
}

export interface RowUpdateResult {
  primaryKey: Record<string, string>;
  error: string | null;
}

@Injectable()
export class UpdateDatabaseRowsUseCase {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    @Inject(MANAGED_DATABASE_REPOSITORY) private readonly databaseRepository: ManagedDatabaseRepository,
    @Inject(DATABASE_QUERY_RUNNER) private readonly queryRunner: DatabaseQueryRunner,
  ) {}

  async execute(projectId: string, table: string, updates: RowUpdateInput[]): Promise<RowUpdateResult[]> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(apiError("PROJECT_NOT_FOUND", `Projeto ${projectId} não encontrado`));
    }
    if (!project.containerName) {
      throw new BadRequestException(
        apiError("DATABASE_CONTAINER_NOT_DEPLOYED", "Este projeto ainda não foi implantado, não há container de banco pra editar."),
      );
    }

    const all = await this.databaseRepository.findAllByProjectId(projectId);
    const database = pickPrimaryDatabase(all.filter((db) => db.type !== "custom"));
    if (!database) {
      throw new BadRequestException(apiError("NO_MANAGED_DATABASE", "Este projeto não tem um banco de dados gerenciado com container."));
    }

    const containerName = `${project.containerName}-${database.serviceName}-1`;

    // "table" vem do front, mas só é usado como identificador SQL/coleção
    // (interpolado direto na query) - confirmar que existe de verdade evita
    // que um nome forjado injete SQL/JS arbitrário via updateRow.
    const knownTables = await this.queryRunner.listTables(containerName, database);
    if (!knownTables.includes(table)) {
      throw new BadRequestException(apiError("UNKNOWN_TABLE", `Tabela/coleção "${table}" não encontrada.`));
    }

    const results: RowUpdateResult[] = [];
    for (const update of updates) {
      try {
        await this.queryRunner.updateRow(containerName, database, table, update.primaryKey, update.changes);
        results.push({ primaryKey: update.primaryKey, error: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ primaryKey: update.primaryKey, error: message });
      }
    }
    return results;
  }
}
