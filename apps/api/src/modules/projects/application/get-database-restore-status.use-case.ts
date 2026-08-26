import { Inject, Injectable } from "@nestjs/common";
import { DATABASE_RESTORER, type DatabaseRestorer, type DatabaseRestoreStatus } from "../domain/database-restorer";

@Injectable()
export class GetDatabaseRestoreStatusUseCase {
  constructor(@Inject(DATABASE_RESTORER) private readonly databaseRestorer: DatabaseRestorer) {}

  execute(projectId: string): Promise<DatabaseRestoreStatus> {
    return this.databaseRestorer.getStatus(projectId);
  }
}
