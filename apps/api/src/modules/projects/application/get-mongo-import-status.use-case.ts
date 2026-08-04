import { Inject, Injectable } from "@nestjs/common";
import { MONGO_IMPORTER, type MongoImporter, type MongoImportStatus } from "../domain/mongo-importer";

@Injectable()
export class GetMongoImportStatusUseCase {
  constructor(@Inject(MONGO_IMPORTER) private readonly mongoImporter: MongoImporter) {}

  execute(projectId: string): Promise<MongoImportStatus> {
    return this.mongoImporter.getStatus(projectId);
  }
}
