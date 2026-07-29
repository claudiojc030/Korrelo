import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { CRON_JOB_REPOSITORY, type CronJobRepository } from "../domain/cron-job.repository";
import { CronJob } from "../domain/cron-job.entity";
import { CronSchedulerService } from "../infrastructure/cron-scheduler.service";
import { assertValidSchedule } from "./create-cron-job.use-case";

export interface UpdateCronJobInput {
  name?: string;
  command?: string;
  schedule?: string;
  enabled?: boolean;
}

@Injectable()
export class UpdateCronJobUseCase {
  constructor(
    @Inject(CRON_JOB_REPOSITORY) private readonly cronJobRepository: CronJobRepository,
    private readonly scheduler: CronSchedulerService,
  ) {}

  async execute(jobId: string, input: UpdateCronJobInput): Promise<CronJob> {
    const job = await this.cronJobRepository.findById(jobId);
    if (!job) {
      throw new NotFoundException(apiError("CRON_JOB_NOT_FOUND", `Cron job ${jobId} não encontrado`));
    }

    const name = input.name?.trim() ?? job.name;
    const command = input.command?.trim() ?? job.command;
    const schedule = input.schedule?.trim() ?? job.schedule;
    const enabled = input.enabled ?? job.enabled;

    if (!name || !command) {
      throw new BadRequestException(apiError("CRON_JOB_NAME_COMMAND_REQUIRED", "Nome e comando são obrigatórios."));
    }
    assertValidSchedule(schedule);

    const updated = job.withSchedule(name, command, schedule, enabled);
    const saved = await this.cronJobRepository.save(updated);

    if (saved.enabled) {
      this.scheduler.scheduleJob(saved);
    } else {
      this.scheduler.unscheduleJob(saved.id);
    }

    return saved;
  }
}
