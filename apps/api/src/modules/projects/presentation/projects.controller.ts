import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from "@nestjs/common";
import { ListProjectsUseCase } from "../application/list-projects.use-case";
import { GetProjectUseCase } from "../application/get-project.use-case";
import { CreateProjectUseCase } from "../application/create-project.use-case";
import { DetectProjectStackUseCase } from "../application/detect-project-stack.use-case";
import { ImportProjectUseCase } from "../application/import-project.use-case";
import { DeployProjectUseCase } from "../application/deploy-project.use-case";
import { DeleteProjectUseCase } from "../application/delete-project.use-case";
import { ListEnvVarsUseCase } from "../application/list-env-vars.use-case";
import { SetEnvVarsUseCase } from "../application/set-env-vars.use-case";
import { GetProjectDiskUsageUseCase } from "../application/get-project-disk-usage.use-case";
import { CreateProjectDto } from "./create-project.dto";
import { DetectStackDto } from "./detect-stack.dto";
import { SetEnvVarsDto } from "./set-env-vars.dto";

@Controller("projects")
export class ProjectsController {
  constructor(
    private readonly listProjects: ListProjectsUseCase,
    private readonly getProject: GetProjectUseCase,
    private readonly createProject: CreateProjectUseCase,
    private readonly detectProjectStack: DetectProjectStackUseCase,
    private readonly importProject: ImportProjectUseCase,
    private readonly deployProject: DeployProjectUseCase,
    private readonly deleteProject: DeleteProjectUseCase,
    private readonly listEnvVars: ListEnvVarsUseCase,
    private readonly setEnvVars: SetEnvVarsUseCase,
    private readonly getProjectDiskUsage: GetProjectDiskUsageUseCase,
  ) {}

  @Get()
  list() {
    return this.listProjects.execute();
  }

  @Post()
  create(@Body() dto: CreateProjectDto) {
    return this.createProject.execute(dto);
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.getProject.execute(id);
  }

  @Get(":id/disk-usage")
  diskUsage(@Param("id") id: string) {
    return this.getProjectDiskUsage.execute(id);
  }

  @Get(":id/env")
  getEnv(@Param("id") id: string) {
    return this.listEnvVars.execute(id);
  }

  @Put(":id/env")
  setEnv(@Param("id") id: string, @Body() dto: SetEnvVarsDto) {
    return this.setEnvVars.execute(id, dto.vars);
  }

  @Post(":id/detect-stack")
  detectStack(@Param("id") id: string, @Body() dto: DetectStackDto) {
    return this.detectProjectStack.execute({ projectId: id, projectPath: dto.path });
  }

  @Post(":id/import")
  importProjectFromGit(@Param("id") id: string) {
    return this.importProject.execute(id);
  }

  @Post(":id/deploy")
  deploy(@Param("id") id: string) {
    return this.deployProject.execute(id);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Param("id") id: string) {
    await this.deleteProject.execute(id);
  }
}
