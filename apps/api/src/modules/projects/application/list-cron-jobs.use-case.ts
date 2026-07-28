import { Inject, Injectable } from "@nestjs/common";
import { CRON_JOB_REPOSITORY, type CronJobRepository } from "../domain/cron-job.repository";
import type { CronJob } from "../domain/cron-job.entity";

@Injectable()
export class ListCronJobsUseCase {
  constructor(@Inject(CRON_JOB_REPOSITORY) private readonly repository: CronJobRepository) {}

  execute(projectId: string): Promise<CronJob[]> {
    return this.repository.findByProjectId(projectId);
  }
}
