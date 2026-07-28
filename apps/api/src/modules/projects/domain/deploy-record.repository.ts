import type { DeployRecord } from "./deploy-record.entity";

export const DEPLOY_RECORD_REPOSITORY = Symbol("DEPLOY_RECORD_REPOSITORY");

export interface DeployRecordRepository {
  findByProjectId(projectId: string, limit: number): Promise<DeployRecord[]>;
  save(record: DeployRecord): Promise<DeployRecord>;
}
