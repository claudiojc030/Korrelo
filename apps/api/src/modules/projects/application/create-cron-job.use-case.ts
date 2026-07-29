import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { CronExpressionParser } from "cron-parser";
import { apiError } from "../../../infrastructure/api-error";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { CRON_JOB_REPOSITORY, type CronJobRepository } from "../domain/cron-job.repository";
import { CronJob } from "../domain/cron-job.entity";
import { CronSchedulerService } from "../infrastructure/cron-scheduler.service";

export function assertValidSchedule(schedule: string): void {
  try {
    CronExpressionParser.parse(schedule);
  } catch {
    throw new BadRequestException(
      apiError(
        "CRON_JOB_INVALID_SCHEDULE",
        `Expressão cron inválida: "${schedule}". Use o formato padrão de 5 campos (ex: "0 3 * * *" = todo dia às 3h).`,
      ),
    );
  }
}

@Injectable()
export class CreateCronJobUseCase {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    @Inject(CRON_JOB_REPOSITORY) private readonly cronJobRepository: CronJobRepository,
    private readonly scheduler: CronSchedulerService,
  ) {}

  async execute(projectId: string, name: string, command: string, schedule: string): Promise<CronJob> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(apiError("PROJECT_NOT_FOUND", `Projeto ${projectId} não encontrado`));
    }
    if (!name.trim() || !command.trim()) {
      throw new BadRequestException(apiError("CRON_JOB_NAME_COMMAND_REQUIRED", "Nome e comando são obrigatórios."));
    }
    assertValidSchedule(schedule);

    const job = CronJob.create(projectId, name.trim(), command.trim(), schedule.trim());
    const saved = await this.cronJobRepository.save(job);
    this.scheduler.scheduleJob(saved);
    return saved;
  }
}
