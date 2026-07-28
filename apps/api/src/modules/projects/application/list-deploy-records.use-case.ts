import { Inject, Injectable } from "@nestjs/common";
import { DEPLOY_RECORD_REPOSITORY, type DeployRecordRepository } from "../domain/deploy-record.repository";
import type { DeployRecord } from "../domain/deploy-record.entity";

@Injectable()
export class ListDeployRecordsUseCase {
  constructor(@Inject(DEPLOY_RECORD_REPOSITORY) private readonly repository: DeployRecordRepository) {}

  execute(projectId: string): Promise<DeployRecord[]> {
    return this.repository.findByProjectId(projectId, 20);
  }
}
