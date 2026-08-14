import type { DeployRecord } from "./deploy-record.entity";

export const DEPLOY_RECORD_REPOSITORY = Symbol("DEPLOY_RECORD_REPOSITORY");

export interface DeployRecordRepository {
  findByProjectId(projectId: string, limit: number, offset?: number): Promise<DeployRecord[]>;
  save(record: DeployRecord): Promise<DeployRecord>;
  // Um deploy travado em "running" pra sempre é sinal de que o processo da
  // API morreu no meio dele (restart do pm2, self-update, crash) - ninguém
  // mais vai chamar save() nele pra fechar. Chamado uma vez na subida da API
  // pra fechar qualquer sobra como "failed" em vez de deixar a UI mostrando
  // "Em andamento" pra sempre.
  failAllRunning(message: string): Promise<number>;
}
