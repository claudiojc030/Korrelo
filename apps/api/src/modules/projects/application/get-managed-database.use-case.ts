import { Inject, Injectable } from "@nestjs/common";
import {
  MANAGED_DATABASE_REPOSITORY,
  type ManagedDatabaseRepository,
} from "../domain/managed-database.repository";
import type { ManagedDatabase } from "../domain/managed-database.entity";

@Injectable()
export class GetManagedDatabaseUseCase {
  constructor(
    @Inject(MANAGED_DATABASE_REPOSITORY) private readonly databaseRepository: ManagedDatabaseRepository,
  ) {}

  execute(projectId: string): Promise<ManagedDatabase | null> {
    return this.databaseRepository.findByProjectId(projectId);
  }
}
