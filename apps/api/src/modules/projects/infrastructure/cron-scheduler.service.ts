import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { CronJob as NodeCronJob } from "cron";
import { CRON_JOB_REPOSITORY, type CronJobRepository } from "../domain/cron-job.repository";
import { CRON_JOB_RUNNER, type CronJobRunner } from "../domain/cron-job-runner";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import type { CronJob } from "../domain/cron-job.entity";

// Registro em memória (via @nestjs/schedule). Nada é escrito no crontab do
// SO. Isso mantém o processo do Core sem nenhum privilégio a mais só por
// causa dessa feature: o "docker exec" que roda o comando do projeto é o
// mesmo mecanismo, sem sudo, que o resto do ForgeDesk já usa.
@Injectable()
export class CronSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(CronSchedulerService.name);

  constructor(
    private readonly schedulerRegistry: SchedulerRegistry,
    @Inject(CRON_JOB_REPOSITORY) private readonly cronJobRepository: CronJobRepository,
    @Inject(CRON_JOB_RUNNER) private readonly cronJobRunner: CronJobRunner,
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    const jobs = await this.cronJobRepository.findAllEnabled();
    for (const job of jobs) {
      this.scheduleJob(job);
    }
    this.logger.log(`${jobs.length} cron job(s) de projeto carregado(s).`);
  }

  scheduleJob(job: CronJob): void {
    this.unscheduleJob(job.id);
    try {
      const nodeCronJob = new NodeCronJob(job.schedule, () => this.executeJob(job.id));
      this.schedulerRegistry.addCronJob(job.id, nodeCronJob);
      nodeCronJob.start();
    } catch (error) {
      this.logger.error(`Não consegui agendar o cron job "${job.name}" (${job.id}): ${error}`);
    }
  }

  unscheduleJob(jobId: string): void {
    if (this.schedulerRegistry.doesExist("cron", jobId)) {
      this.schedulerRegistry.deleteCronJob(jobId);
    }
  }

  async runNow(jobId: string): Promise<void> {
    await this.executeJob(jobId);
  }

  private async executeJob(jobId: string): Promise<void> {
    const job = await this.cronJobRepository.findById(jobId);
    if (!job || !job.enabled) return;

    const project = await this.projectRepository.findById(job.projectId);
    if (!project || !project.containerName || project.status !== "running") {
      await this.cronJobRepository.save(
        job.withRunResult("failed", "Projeto não encontrado ou não está rodando no momento da execução."),
      );
      return;
    }

    const result = await this.cronJobRunner.run(project.containerName, job.command);
    await this.cronJobRepository.save(job.withRunResult(result.status, result.output));
  }
}
