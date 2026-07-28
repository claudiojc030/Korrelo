import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { ListCronJobsUseCase } from "../application/list-cron-jobs.use-case";
import { CreateCronJobUseCase } from "../application/create-cron-job.use-case";
import { UpdateCronJobUseCase } from "../application/update-cron-job.use-case";
import { DeleteCronJobUseCase } from "../application/delete-cron-job.use-case";
import { RunCronJobNowUseCase } from "../application/run-cron-job-now.use-case";
import { CreateCronJobDto } from "./create-cron-job.dto";
import { UpdateCronJobDto } from "./update-cron-job.dto";

@Controller("projects/:projectId/cron")
export class CronJobsController {
  constructor(
    private readonly listCronJobs: ListCronJobsUseCase,
    private readonly createCronJob: CreateCronJobUseCase,
    private readonly updateCronJob: UpdateCronJobUseCase,
    private readonly deleteCronJob: DeleteCronJobUseCase,
    private readonly runCronJobNow: RunCronJobNowUseCase,
  ) {}

  @Get()
  list(@Param("projectId") projectId: string) {
    return this.listCronJobs.execute(projectId);
  }

  @Post()
  create(@Param("projectId") projectId: string, @Body() dto: CreateCronJobDto) {
    return this.createCronJob.execute(projectId, dto.name, dto.command, dto.schedule);
  }

  @Patch(":jobId")
  update(@Param("jobId") jobId: string, @Body() dto: UpdateCronJobDto) {
    return this.updateCronJob.execute(jobId, dto);
  }

  @Delete(":jobId")
  @HttpCode(204)
  async remove(@Param("jobId") jobId: string) {
    await this.deleteCronJob.execute(jobId);
  }

  @Post(":jobId/run")
  runNow(@Param("jobId") jobId: string) {
    return this.runCronJobNow.execute(jobId);
  }
}
