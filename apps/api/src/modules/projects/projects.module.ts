import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { GithubModule } from "../github/github.module";
import { AuthModule } from "../auth/auth.module";
import { ProjectsController } from "./presentation/projects.controller";
import { CronJobsController } from "./presentation/cron-jobs.controller";
import { GithubWebhookController } from "./presentation/github-webhook.controller";
import { ProjectFilesController } from "./presentation/project-files.controller";
import { ListProjectsUseCase } from "./application/list-projects.use-case";
import { GetProjectUseCase } from "./application/get-project.use-case";
import { CreateProjectUseCase } from "./application/create-project.use-case";
import { DetectProjectStackUseCase } from "./application/detect-project-stack.use-case";
import { ImportProjectUseCase } from "./application/import-project.use-case";
import { DeployProjectUseCase } from "./application/deploy-project.use-case";
import { DeleteProjectUseCase } from "./application/delete-project.use-case";
import { ListEnvVarsUseCase } from "./application/list-env-vars.use-case";
import { SetEnvVarsUseCase } from "./application/set-env-vars.use-case";
import { GetProjectDiskUsageUseCase } from "./application/get-project-disk-usage.use-case";
import { ProvisionDatabaseUseCase } from "./application/provision-database.use-case";
import { DeprovisionDatabaseUseCase } from "./application/deprovision-database.use-case";
import { GetManagedDatabaseUseCase } from "./application/get-managed-database.use-case";
import { UpdateProjectSettingsUseCase } from "./application/update-project-settings.use-case";
import { GetProjectLogsUseCase } from "./application/get-project-logs.use-case";
import { AttachDomainUseCase } from "./application/attach-domain.use-case";
import { DetachDomainUseCase } from "./application/detach-domain.use-case";
import { AddDomainAliasUseCase } from "./application/add-domain-alias.use-case";
import { RemoveDomainAliasUseCase } from "./application/remove-domain-alias.use-case";
import { ListDomainAliasesUseCase } from "./application/list-domain-aliases.use-case";
import { ListDeployRecordsUseCase } from "./application/list-deploy-records.use-case";
import { ListDatabaseTablesUseCase } from "./application/list-database-tables.use-case";
import { RunDatabaseQueryUseCase } from "./application/run-database-query.use-case";
import { StartMongoImportUseCase } from "./application/start-mongo-import.use-case";
import { GetMongoImportStatusUseCase } from "./application/get-mongo-import-status.use-case";
import { StartDatabaseExportUseCase } from "./application/start-database-export.use-case";
import { GetDatabaseExportStatusUseCase } from "./application/get-database-export-status.use-case";
import { GetDatabaseExportFileUseCase } from "./application/get-database-export-file.use-case";
import { ListCronJobsUseCase } from "./application/list-cron-jobs.use-case";
import { CreateCronJobUseCase } from "./application/create-cron-job.use-case";
import { UpdateCronJobUseCase } from "./application/update-cron-job.use-case";
import { DeleteCronJobUseCase } from "./application/delete-cron-job.use-case";
import { RunCronJobNowUseCase } from "./application/run-cron-job-now.use-case";
import { HandleGithubPushWebhookUseCase } from "./application/handle-github-push-webhook.use-case";
import { ListProjectFilesUseCase } from "./application/list-project-files.use-case";
import { ReadProjectFileUseCase } from "./application/read-project-file.use-case";
import { WriteProjectFileUseCase } from "./application/write-project-file.use-case";
import { PrismaProjectRepository } from "./infrastructure/prisma-project.repository";
import { PrismaEnvVarRepository } from "./infrastructure/prisma-env-var.repository";
import { PrismaManagedDatabaseRepository } from "./infrastructure/prisma-managed-database.repository";
import { PrismaProjectDomainAliasRepository } from "./infrastructure/prisma-project-domain-alias.repository";
import { PrismaDeployRecordRepository } from "./infrastructure/prisma-deploy-record.repository";
import { FileBasedStackDetector } from "./infrastructure/file-based-stack-detector";
import { SimpleGitRepositoryCloner } from "./infrastructure/simple-git-repository-cloner";
import { NodeDockerfileGenerator } from "./infrastructure/node-dockerfile-generator";
import { PhpDockerfileGenerator } from "./infrastructure/php-dockerfile-generator";
import { PythonDockerfileGenerator } from "./infrastructure/python-dockerfile-generator";
import { GoDockerfileGenerator } from "./infrastructure/go-dockerfile-generator";
import { RustDockerfileGenerator } from "./infrastructure/rust-dockerfile-generator";
import { JavaDockerfileGenerator } from "./infrastructure/java-dockerfile-generator";
import { DotnetDockerfileGenerator } from "./infrastructure/dotnet-dockerfile-generator";
import { DockerfileGeneratorRegistry } from "./infrastructure/dockerfile-generator-registry";
import { DockerComposeOrchestrator } from "./infrastructure/docker-compose-orchestrator";
import { DockerComposeFileBuilder } from "./infrastructure/docker-compose-file-builder";
import { PortAllocator } from "./infrastructure/port-allocator";
import { ResourceBudgetCalculator } from "./infrastructure/resource-budget-calculator";
import { HttpHealthChecker } from "./infrastructure/http-health-checker";
import { DockerLogReader } from "./infrastructure/docker-log-reader";
import { NginxCertbotDomainProvisioner } from "./infrastructure/nginx-certbot-domain-provisioner";
import { ProjectDiskUsageService } from "./infrastructure/project-disk-usage.service";
import { PrismaCronJobRepository } from "./infrastructure/prisma-cron-job.repository";
import { DockerExecCronRunner } from "./infrastructure/docker-exec-cron-runner";
import { DockerExecDatabaseQueryRunner } from "./infrastructure/docker-exec-database-query-runner";
import { ScriptMongoImporter } from "./infrastructure/script-mongo-importer";
import { ScriptDatabaseExporter } from "./infrastructure/script-database-exporter";
import { CronSchedulerService } from "./infrastructure/cron-scheduler.service";
import { DiskUsageAlertScheduler } from "./infrastructure/disk-usage-alert.scheduler";
import { DeployRecoveryService } from "./infrastructure/deploy-recovery.service";
import { EnvVarCipher } from "../../infrastructure/crypto/env-var-cipher";
import { PROJECT_REPOSITORY } from "./domain/project.repository";
import { ENV_VAR_REPOSITORY } from "./domain/env-var.repository";
import { MANAGED_DATABASE_REPOSITORY } from "./domain/managed-database.repository";
import { PROJECT_DOMAIN_ALIAS_REPOSITORY } from "./domain/project-domain-alias.repository";
import { STACK_DETECTOR } from "./domain/stack-detector";
import { REPOSITORY_CLONER } from "./domain/repository-cloner";
import { DOCKERFILE_GENERATOR } from "./domain/dockerfile-generator";
import { CONTAINER_ORCHESTRATOR } from "./domain/container-orchestrator";
import { HEALTH_CHECKER } from "./domain/health-checker";
import { LOG_READER } from "./domain/log-reader";
import { DOMAIN_PROVISIONER } from "./domain/domain-provisioner";
import { DEPLOY_RECORD_REPOSITORY } from "./domain/deploy-record.repository";
import { CRON_JOB_REPOSITORY } from "./domain/cron-job.repository";
import { CRON_JOB_RUNNER } from "./domain/cron-job-runner";
import { DATABASE_QUERY_RUNNER } from "./domain/database-query-runner";
import { MONGO_IMPORTER } from "./domain/mongo-importer";
import { DATABASE_EXPORTER } from "./domain/database-exporter";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";

@Module({
  imports: [GithubModule, AuthModule, ScheduleModule.forRoot()],
  controllers: [ProjectsController, CronJobsController, GithubWebhookController, ProjectFilesController],
  providers: [
    PrismaService,
    HandleGithubPushWebhookUseCase,
    ListProjectFilesUseCase,
    ReadProjectFileUseCase,
    WriteProjectFileUseCase,
    ListCronJobsUseCase,
    CreateCronJobUseCase,
    UpdateCronJobUseCase,
    DeleteCronJobUseCase,
    RunCronJobNowUseCase,
    CronSchedulerService,
    DiskUsageAlertScheduler,
    DeployRecoveryService,
    ListProjectsUseCase,
    GetProjectUseCase,
    CreateProjectUseCase,
    DetectProjectStackUseCase,
    ImportProjectUseCase,
    DeployProjectUseCase,
    DeleteProjectUseCase,
    ListEnvVarsUseCase,
    SetEnvVarsUseCase,
    GetProjectDiskUsageUseCase,
    ProvisionDatabaseUseCase,
    DeprovisionDatabaseUseCase,
    GetManagedDatabaseUseCase,
    UpdateProjectSettingsUseCase,
    GetProjectLogsUseCase,
    AttachDomainUseCase,
    DetachDomainUseCase,
    AddDomainAliasUseCase,
    RemoveDomainAliasUseCase,
    ListDomainAliasesUseCase,
    ListDeployRecordsUseCase,
    ListDatabaseTablesUseCase,
    RunDatabaseQueryUseCase,
    StartMongoImportUseCase,
    GetMongoImportStatusUseCase,
    StartDatabaseExportUseCase,
    GetDatabaseExportStatusUseCase,
    GetDatabaseExportFileUseCase,
    NodeDockerfileGenerator,
    PhpDockerfileGenerator,
    PythonDockerfileGenerator,
    GoDockerfileGenerator,
    RustDockerfileGenerator,
    JavaDockerfileGenerator,
    DotnetDockerfileGenerator,
    DockerComposeFileBuilder,
    PortAllocator,
    ResourceBudgetCalculator,
    ProjectDiskUsageService,
    EnvVarCipher,
    { provide: PROJECT_REPOSITORY, useClass: PrismaProjectRepository },
    { provide: ENV_VAR_REPOSITORY, useClass: PrismaEnvVarRepository },
    { provide: MANAGED_DATABASE_REPOSITORY, useClass: PrismaManagedDatabaseRepository },
    { provide: PROJECT_DOMAIN_ALIAS_REPOSITORY, useClass: PrismaProjectDomainAliasRepository },
    { provide: STACK_DETECTOR, useClass: FileBasedStackDetector },
    { provide: REPOSITORY_CLONER, useClass: SimpleGitRepositoryCloner },
    { provide: DOCKERFILE_GENERATOR, useClass: DockerfileGeneratorRegistry },
    { provide: CONTAINER_ORCHESTRATOR, useClass: DockerComposeOrchestrator },
    { provide: HEALTH_CHECKER, useClass: HttpHealthChecker },
    { provide: LOG_READER, useClass: DockerLogReader },
    { provide: DOMAIN_PROVISIONER, useClass: NginxCertbotDomainProvisioner },
    { provide: DEPLOY_RECORD_REPOSITORY, useClass: PrismaDeployRecordRepository },
    { provide: CRON_JOB_REPOSITORY, useClass: PrismaCronJobRepository },
    { provide: CRON_JOB_RUNNER, useClass: DockerExecCronRunner },
    { provide: DATABASE_QUERY_RUNNER, useClass: DockerExecDatabaseQueryRunner },
    { provide: MONGO_IMPORTER, useClass: ScriptMongoImporter },
    { provide: DATABASE_EXPORTER, useClass: ScriptDatabaseExporter },
  ],
  exports: [PROJECT_REPOSITORY],
})
export class ProjectsModule {}
