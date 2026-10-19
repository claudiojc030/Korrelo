import type { DeployJob, DeployJobStatus } from "./deploy-job.entity";

export const DEPLOY_JOB_REPOSITORY = Symbol("DEPLOY_JOB_REPOSITORY");

export interface DeployJobRepository {
  create(job: DeployJob): Promise<DeployJob>;
  save(job: DeployJob): Promise<DeployJob>;
  findById(id: string): Promise<DeployJob | null>;
  /** Job mais antigo com status "queued" (o próximo da fila). */
  findNextQueued(excludeIds?: string[]): Promise<DeployJob | null>;
  /** Job em aberto (queued ou running) do projeto. */
  findOpenByProject(projectId: string): Promise<DeployJob | null>;
  /** Job (qualquer estado) do projeto com aquele commit. */
  findByProjectAndCommit(projectId: string, commitSha: string): Promise<DeployJob | null>;
  findAllByStatus(status: DeployJobStatus): Promise<DeployJob[]>;
  findLatestByProject(projectId: string): Promise<DeployJob | null>;
  findRecent(limit: number): Promise<DeployJob[]>;
  countByStatus(status: DeployJobStatus): Promise<number>;
}
