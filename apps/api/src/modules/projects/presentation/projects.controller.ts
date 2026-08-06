import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from "@nestjs/common";
import type { Response } from "express";
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
import { ProvisionDatabaseUseCase } from "../application/provision-database.use-case";
import { DeprovisionDatabaseUseCase } from "../application/deprovision-database.use-case";
import { GetManagedDatabaseUseCase } from "../application/get-managed-database.use-case";
import { UpdateProjectSettingsUseCase } from "../application/update-project-settings.use-case";
import { GetProjectLogsUseCase, type LogTarget } from "../application/get-project-logs.use-case";
import { AttachDomainUseCase } from "../application/attach-domain.use-case";
import { DetachDomainUseCase } from "../application/detach-domain.use-case";
import { ListDeployRecordsUseCase } from "../application/list-deploy-records.use-case";
import { ListDatabaseTablesUseCase } from "../application/list-database-tables.use-case";
import { RunDatabaseQueryUseCase } from "../application/run-database-query.use-case";
import { StartMongoImportUseCase } from "../application/start-mongo-import.use-case";
import { GetMongoImportStatusUseCase } from "../application/get-mongo-import-status.use-case";
import { StartDatabaseExportUseCase } from "../application/start-database-export.use-case";
import { GetDatabaseExportStatusUseCase } from "../application/get-database-export-status.use-case";
import { GetDatabaseExportFileUseCase } from "../application/get-database-export-file.use-case";
import { CreateProjectDto } from "./create-project.dto";
import { DetectStackDto } from "./detect-stack.dto";
import { SetEnvVarsDto } from "./set-env-vars.dto";
import { ProvisionDatabaseDto } from "./provision-database.dto";
import { RunDatabaseQueryDto } from "./run-database-query.dto";
import { StartMongoImportDto } from "./start-mongo-import.dto";
import { UpdateProjectSettingsDto } from "./update-project-settings.dto";
import { AttachDomainDto } from "./attach-domain.dto";

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
    private readonly provisionDatabase: ProvisionDatabaseUseCase,
    private readonly deprovisionDatabase: DeprovisionDatabaseUseCase,
    private readonly getManagedDatabase: GetManagedDatabaseUseCase,
    private readonly updateProjectSettings: UpdateProjectSettingsUseCase,
    private readonly getProjectLogs: GetProjectLogsUseCase,
    private readonly attachDomain: AttachDomainUseCase,
    private readonly detachDomain: DetachDomainUseCase,
    private readonly listDeployRecords: ListDeployRecordsUseCase,
    private readonly listDatabaseTables: ListDatabaseTablesUseCase,
    private readonly runDatabaseQuery: RunDatabaseQueryUseCase,
    private readonly startMongoImport: StartMongoImportUseCase,
    private readonly getMongoImportStatus: GetMongoImportStatusUseCase,
    private readonly startDatabaseExport: StartDatabaseExportUseCase,
    private readonly getDatabaseExportStatus: GetDatabaseExportStatusUseCase,
    private readonly getDatabaseExportFile: GetDatabaseExportFileUseCase,
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

  @Patch(":id/settings")
  updateSettings(@Param("id") id: string, @Body() dto: UpdateProjectSettingsDto) {
    return this.updateProjectSettings.execute(id, dto);
  }

  @Get(":id/logs")
  getLogs(@Param("id") id: string, @Query("target") target?: string, @Query("tail") tail?: string) {
    const logTarget: LogTarget = target === "database" ? "database" : "app";
    const tailLines = Math.min(Math.max(Number.parseInt(tail ?? "200", 10) || 200, 20), 2000);
    return this.getProjectLogs.execute(id, logTarget, tailLines);
  }

  @Post(":id/domain")
  attachDomainEndpoint(@Param("id") id: string, @Body() dto: AttachDomainDto) {
    return this.attachDomain.execute(id, dto.domain);
  }

  @Delete(":id/domain")
  detachDomainEndpoint(@Param("id") id: string) {
    return this.detachDomain.execute(id);
  }

  @Get(":id/database")
  getDatabase(@Param("id") id: string) {
    return this.getManagedDatabase.execute(id);
  }

  @Post(":id/database")
  provisionDatabaseEndpoint(@Param("id") id: string, @Body() dto: ProvisionDatabaseDto) {
    return this.provisionDatabase.execute(id, dto.type, {
      connectionString: dto.connectionString,
      envVarKey: dto.envVarKey,
      persistRedis: dto.persistRedis,
    });
  }

  @Delete(":id/database")
  @HttpCode(204)
  async removeDatabase(@Param("id") id: string) {
    await this.deprovisionDatabase.execute(id);
  }

  @Get(":id/database/tables")
  getDatabaseTables(@Param("id") id: string) {
    return this.listDatabaseTables.execute(id).then((tables) => ({ tables }));
  }

  @Post(":id/database/query")
  runDatabaseQueryEndpoint(@Param("id") id: string, @Body() dto: RunDatabaseQueryDto) {
    return this.runDatabaseQuery.execute(id, dto.query);
  }

  @Post(":id/database/mongo-import")
  startMongoImportEndpoint(@Param("id") id: string, @Body() dto: StartMongoImportDto) {
    return this.startMongoImport.execute(id, dto.sourceUri);
  }

  @Get(":id/database/mongo-import/status")
  getMongoImportStatusEndpoint(@Param("id") id: string) {
    return this.getMongoImportStatus.execute(id);
  }

  @Post(":id/database/export")
  startDatabaseExportEndpoint(@Param("id") id: string) {
    return this.startDatabaseExport.execute(id);
  }

  @Get(":id/database/export/status")
  getDatabaseExportStatusEndpoint(@Param("id") id: string) {
    return this.getDatabaseExportStatus.execute(id);
  }

  @Get(":id/database/export/download")
  async downloadDatabaseExportEndpoint(@Param("id") id: string, @Res() res: Response) {
    const { filePath, fileName } = await this.getDatabaseExportFile.execute(id);
    res.download(filePath, fileName);
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
    return this.deployProject.execute(id, "manual");
  }

  @Get(":id/deploys")
  getDeploys(@Param("id") id: string) {
    return this.listDeployRecords.execute(id);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Param("id") id: string) {
    await this.deleteProject.execute(id);
  }
}
