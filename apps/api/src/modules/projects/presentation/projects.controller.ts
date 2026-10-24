import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { ListProjectsUseCase } from "../application/list-projects.use-case";
import { GetProjectUseCase } from "../application/get-project.use-case";
import { CreateProjectUseCase } from "../application/create-project.use-case";
import { DetectProjectStackUseCase } from "../application/detect-project-stack.use-case";
import { ImportProjectUseCase } from "../application/import-project.use-case";
import { DeleteProjectUseCase } from "../application/delete-project.use-case";
import { ListEnvVarsUseCase } from "../application/list-env-vars.use-case";
import { SetEnvVarsUseCase } from "../application/set-env-vars.use-case";
import { GetProjectDiskUsageUseCase } from "../application/get-project-disk-usage.use-case";
import { PreviewProjectDeployUseCase } from "../application/preview-project-deploy.use-case";
import { ProvisionDatabaseUseCase } from "../application/provision-database.use-case";
import { DeprovisionDatabaseUseCase } from "../application/deprovision-database.use-case";
import { GetManagedDatabaseUseCase } from "../application/get-managed-database.use-case";
import type { DatabaseType } from "../domain/managed-database.entity";
import { UpdateProjectSettingsUseCase } from "../application/update-project-settings.use-case";
import { GetProjectLogsUseCase, type LogTarget } from "../application/get-project-logs.use-case";
import { AttachDomainUseCase } from "../application/attach-domain.use-case";
import { DetachDomainUseCase } from "../application/detach-domain.use-case";
import { AddDomainAliasUseCase } from "../application/add-domain-alias.use-case";
import { RemoveDomainAliasUseCase } from "../application/remove-domain-alias.use-case";
import { ListDomainAliasesUseCase } from "../application/list-domain-aliases.use-case";
import { ListDeployRecordsUseCase } from "../application/list-deploy-records.use-case";
import { ListDatabaseTablesUseCase } from "../application/list-database-tables.use-case";
import { RunDatabaseQueryUseCase } from "../application/run-database-query.use-case";
import { GetTablePrimaryKeyUseCase } from "../application/get-table-primary-key.use-case";
import { UpdateDatabaseRowsUseCase } from "../application/update-database-rows.use-case";
import { DeleteDatabaseRowsUseCase } from "../application/delete-database-rows.use-case";
import { StartMongoImportUseCase } from "../application/start-mongo-import.use-case";
import { GetMongoImportStatusUseCase } from "../application/get-mongo-import-status.use-case";
import { StartDatabaseExportUseCase } from "../application/start-database-export.use-case";
import { GetDatabaseExportStatusUseCase } from "../application/get-database-export-status.use-case";
import { GetDatabaseExportFileUseCase } from "../application/get-database-export-file.use-case";
import { ListProjectBackupsUseCase } from "../application/list-project-backups.use-case";
import { StartProjectBackupUseCase } from "../application/start-project-backup.use-case";
import { DownloadProjectBackupUseCase } from "../application/download-project-backup.use-case";
import { StartDatabaseRestoreUseCase } from "../application/start-database-restore.use-case";
import { GetDatabaseRestoreStatusUseCase } from "../application/get-database-restore-status.use-case";
import { CreateProjectDto } from "./create-project.dto";
import { DetectStackDto } from "./detect-stack.dto";
import { SetEnvVarsDto } from "./set-env-vars.dto";
import { ProvisionDatabaseDto } from "./provision-database.dto";
import { RunDatabaseQueryDto } from "./run-database-query.dto";
import { UpdateDatabaseRowsDto } from "./update-database-rows.dto";
import { DeleteDatabaseRowsDto } from "./delete-database-rows.dto";
import { StartMongoImportDto } from "./start-mongo-import.dto";
import { UpdateProjectSettingsDto } from "./update-project-settings.dto";
import { AttachDomainDto } from "./attach-domain.dto";
import { DeployQueueService } from "../infrastructure/deploy-queue.service";
import { ReconcileProjectStateUseCase } from "../application/reconcile-project-state.use-case";

@Controller("projects")
export class ProjectsController {
  constructor(
    private readonly listProjects: ListProjectsUseCase,
    private readonly getProject: GetProjectUseCase,
    private readonly createProject: CreateProjectUseCase,
    private readonly detectProjectStack: DetectProjectStackUseCase,
    private readonly importProject: ImportProjectUseCase,
    private readonly deployQueue: DeployQueueService,
    private readonly deleteProject: DeleteProjectUseCase,
    private readonly listEnvVars: ListEnvVarsUseCase,
    private readonly setEnvVars: SetEnvVarsUseCase,
    private readonly getProjectDiskUsage: GetProjectDiskUsageUseCase,
    private readonly previewProjectDeploy: PreviewProjectDeployUseCase,
    private readonly provisionDatabase: ProvisionDatabaseUseCase,
    private readonly deprovisionDatabase: DeprovisionDatabaseUseCase,
    private readonly getManagedDatabase: GetManagedDatabaseUseCase,
    private readonly updateProjectSettings: UpdateProjectSettingsUseCase,
    private readonly getProjectLogs: GetProjectLogsUseCase,
    private readonly attachDomain: AttachDomainUseCase,
    private readonly detachDomain: DetachDomainUseCase,
    private readonly addDomainAlias: AddDomainAliasUseCase,
    private readonly removeDomainAlias: RemoveDomainAliasUseCase,
    private readonly listDomainAliases: ListDomainAliasesUseCase,
    private readonly listDeployRecords: ListDeployRecordsUseCase,
    private readonly listDatabaseTables: ListDatabaseTablesUseCase,
    private readonly runDatabaseQuery: RunDatabaseQueryUseCase,
    private readonly getTablePrimaryKey: GetTablePrimaryKeyUseCase,
    private readonly updateDatabaseRows: UpdateDatabaseRowsUseCase,
    private readonly deleteDatabaseRows: DeleteDatabaseRowsUseCase,
    private readonly startMongoImport: StartMongoImportUseCase,
    private readonly getMongoImportStatus: GetMongoImportStatusUseCase,
    private readonly startDatabaseExport: StartDatabaseExportUseCase,
    private readonly getDatabaseExportStatus: GetDatabaseExportStatusUseCase,
    private readonly getDatabaseExportFile: GetDatabaseExportFileUseCase,
    private readonly listProjectBackups: ListProjectBackupsUseCase,
    private readonly startProjectBackup: StartProjectBackupUseCase,
    private readonly downloadProjectBackup: DownloadProjectBackupUseCase,
    private readonly startDatabaseRestore: StartDatabaseRestoreUseCase,
    private readonly getDatabaseRestoreStatus: GetDatabaseRestoreStatusUseCase,
    private readonly reconcileProjectState: ReconcileProjectStateUseCase,
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

  /**
   * DRY-RUN do deploy: mostra o que o deploy faria (recursos, limites,
   * staging, health, promoção e rollback) SEM tocar em Docker.
   */
  @Get(":id/deploy-dry-run")
  deployDryRun(@Param("id") id: string, @Query("commit") commit?: string, @Query("branch") branch?: string) {
    return this.previewProjectDeploy.execute(id, { commit: commit ?? null, branch: branch ?? null });
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

  @Get(":id/domain/aliases")
  getDomainAliases(@Param("id") id: string) {
    return this.listDomainAliases.execute(id);
  }

  @Post(":id/domain/aliases")
  addDomainAliasEndpoint(@Param("id") id: string, @Body() dto: AttachDomainDto) {
    return this.addDomainAlias.execute(id, dto.domain);
  }

  @Delete(":id/domain/aliases/:domain")
  removeDomainAliasEndpoint(@Param("id") id: string, @Param("domain") domain: string) {
    return this.removeDomainAlias.execute(id, domain);
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
  async removeDatabase(@Param("id") id: string, @Query("type") type: DatabaseType) {
    await this.deprovisionDatabase.execute(id, type);
  }

  @Get(":id/database/tables")
  getDatabaseTables(@Param("id") id: string) {
    return this.listDatabaseTables.execute(id).then((tables) => ({ tables }));
  }

  @Post(":id/database/query")
  runDatabaseQueryEndpoint(@Param("id") id: string, @Body() dto: RunDatabaseQueryDto) {
    return this.runDatabaseQuery.execute(id, dto.query);
  }

  @Get(":id/database/tables/:table/primary-key")
  getTablePrimaryKeyEndpoint(@Param("id") id: string, @Param("table") table: string) {
    return this.getTablePrimaryKey.execute(id, table).then((columns) => ({ columns }));
  }

  @Post(":id/database/rows")
  updateDatabaseRowsEndpoint(@Param("id") id: string, @Body() dto: UpdateDatabaseRowsDto) {
    return this.updateDatabaseRows.execute(id, dto.table, dto.updates).then((results) => ({ results }));
  }

  @Delete(":id/database/rows")
  deleteDatabaseRowsEndpoint(@Param("id") id: string, @Body() dto: DeleteDatabaseRowsDto) {
    return this.deleteDatabaseRows.execute(id, dto.table, dto.primaryKeys).then((results) => ({ results }));
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

  @Get(":id/database/backups")
  listBackupsEndpoint(@Param("id") id: string) {
    return this.listProjectBackups.execute(id);
  }

  @Post(":id/database/backups")
  startBackupEndpoint(@Param("id") id: string) {
    // Reaproveita o status do export existente (:id/database/export/status)
    // pra acompanhar o andamento - é a mesma máquina por baixo (ver
    // StartProjectBackupUseCase), só muda pra onde o dump vai.
    return this.startProjectBackup.execute(id);
  }

  @Get(":id/database/backups/:backupId/download")
  async downloadBackupEndpoint(@Param("id") id: string, @Param("backupId") backupId: string, @Res() res: Response) {
    const { filePath, fileName } = await this.downloadProjectBackup.execute(id, backupId);
    res.download(filePath, fileName);
  }

  @Post(":id/database/backups/:backupId/restore")
  startRestoreEndpoint(@Param("id") id: string, @Param("backupId") backupId: string) {
    return this.startDatabaseRestore.execute(id, backupId);
  }

  @Get(":id/database/restore/status")
  getRestoreStatusEndpoint(@Param("id") id: string) {
    return this.getDatabaseRestoreStatus.execute(id);
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
  @HttpCode(202)
  async deploy(@Param("id") id: string) {
    // Não espera o deploy inteiro terminar (pode levar minutos: build + health
    // check + promote) - sem isso, a requisição do botão "Deploy" ficava
    // pendurada o tempo todo, e a UI só sabia atualizar QUALQUER COISA (logs,
    // status) depois que a resposta chegasse no fim.
    //
    // Wave 2: o deploy entra na FILA GLOBAL (um por vez na VPS inteira) e o
    // worker executa depois. O commit é resolvido na hora de rodar (é nesse
    // momento que o repositório é buscado e o commit exato é checado out).
    const project = await this.getProject.execute(id);
    const { job } = await this.deployQueue.enqueue({
      projectId: project.id,
      commitSha: null,
      branch: project.deployBranch,
      trigger: "manual",
    });
    return { ok: true, jobId: job.id, status: job.status };
  }

  @Get(":id/deploys")
  getDeploys(@Param("id") id: string, @Query("offset") offset?: string) {
    return this.listDeployRecords.execute(id, offset ? Number(offset) : 0);
  }

  /**
   * RECONCILIAÇÃO de projeto em ESTADO INDETERMINADO.
   *
   * Confere o container real (nada de Compose/reinício) e só então libera
   * novos deploys. Recusa quando a identidade da imagem não é comprovável.
   */
  @Post(":id/reconcile")
  @HttpCode(200)
  reconcile(@Param("id") id: string) {
    return this.reconcileProjectState.execute(id);
  }

  /**
   * STAGING-ONLY (opcional): builda, sobe SÓ o container de teste, roda o
   * health, registra o resultado e remove o container. Não promove, não
   * altera currentImage/previousImage e não reinicia a produção.
   *
   * O fluxo padrão (`POST :id/deploy`) continua com promoção automática.
   */
  @Post(":id/deploy-staging")
  @HttpCode(202)
  async deployStagingOnly(@Param("id") id: string) {
    const project = await this.getProject.execute(id);
    const { job, created } = await this.deployQueue.enqueue({
      projectId: project.id,
      commitSha: null,
      branch: project.deployBranch,
      trigger: "staging",
    });
    return { ok: true, jobId: job.id, status: job.status, stagingOnly: true, created };
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Param("id") id: string) {
    await this.deleteProject.execute(id);
  }
}
