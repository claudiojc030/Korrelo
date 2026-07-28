import type { CronJob } from "./cron-job.entity";

export const CRON_JOB_REPOSITORY = Symbol("CRON_JOB_REPOSITORY");

export interface CronJobRepository {
  findAllEnabled(): Promise<CronJob[]>;
  findByProjectId(projectId: string): Promise<CronJob[]>;
  findById(id: string): Promise<CronJob | null>;
  save(job: CronJob): Promise<CronJob>;
  delete(id: string): Promise<void>;
}
