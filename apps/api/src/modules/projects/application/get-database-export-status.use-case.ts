import { Inject, Injectable } from "@nestjs/common";
import { DATABASE_EXPORTER, type DatabaseExporter, type DatabaseExportStatus } from "../domain/database-exporter";

@Injectable()
export class GetDatabaseExportStatusUseCase {
  constructor(@Inject(DATABASE_EXPORTER) private readonly databaseExporter: DatabaseExporter) {}

  execute(projectId: string): Promise<DatabaseExportStatus> {
    return this.databaseExporter.getStatus(projectId);
  }
}
