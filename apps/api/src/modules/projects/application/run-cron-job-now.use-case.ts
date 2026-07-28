import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { CRON_JOB_REPOSITORY, type CronJobRepository } from "../domain/cron-job.repository";
import { CronSchedulerService } from "../infrastructure/cron-scheduler.service";
import type { CronJob } from "../domain/cron-job.entity";

@Injectable()
export class RunCronJobNowUseCase {
  constructor(
    @Inject(CRON_JOB_REPOSITORY) private readonly cronJobRepository: CronJobRepository,
    private readonly scheduler: CronSchedulerService,
  ) {}

  async execute(jobId: string): Promise<CronJob> {
    const job = await this.cronJobRepository.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Cron job ${jobId} não encontrado`);
    }
    await this.scheduler.runNow(jobId);
    const refreshed = await this.cronJobRepository.findById(jobId);
    return refreshed!;
  }
}
