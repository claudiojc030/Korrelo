import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import * as path from "node:path";
import { apiError } from "../../../infrastructure/api-error";
import { DATABASE_EXPORTER, type DatabaseExporter } from "../domain/database-exporter";

@Injectable()
export class GetDatabaseExportFileUseCase {
  constructor(@Inject(DATABASE_EXPORTER) private readonly databaseExporter: DatabaseExporter) {}

  async execute(projectId: string): Promise<{ filePath: string; fileName: string }> {
    const filePath = await this.databaseExporter.getFilePath(projectId);
    if (!filePath) {
      throw new NotFoundException(apiError("DATABASE_EXPORT_NOT_FOUND", "Nenhuma exportação disponível pra este projeto."));
    }
    return { filePath, fileName: path.basename(filePath) };
  }
}
