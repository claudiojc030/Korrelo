import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { CRON_JOB_REPOSITORY, type CronJobRepository } from "../domain/cron-job.repository";
import { CronSchedulerService } from "../infrastructure/cron-scheduler.service";

@Injectable()
export class DeleteCronJobUseCase {
  constructor(
    @Inject(CRON_JOB_REPOSITORY) private readonly cronJobRepository: CronJobRepository,
    private readonly scheduler: CronSchedulerService,
  ) {}

  async execute(jobId: string): Promise<void> {
    const job = await this.cronJobRepository.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Cron job ${jobId} não encontrado`);
    }
    this.scheduler.unscheduleJob(jobId);
    await this.cronJobRepository.delete(jobId);
  }
}
