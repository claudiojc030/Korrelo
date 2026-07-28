import { Module } from "@nestjs/common";
import { GithubModule } from "../github/github.module";
import { ProjectsController } from "./presentation/projects.controller";
import { ListProjectsUseCase } from "./application/list-projects.use-case";
import { CreateProjectUseCase } from "./application/create-project.use-case";
import { DetectProjectStackUseCase } from "./application/detect-project-stack.use-case";
import { ImportProjectUseCase } from "./application/import-project.use-case";
import { DeployProjectUseCase } from "./application/deploy-project.use-case";
import { PrismaProjectRepository } from "./infrastructure/prisma-project.repository";
import { FileBasedStackDetector } from "./infrastructure/file-based-stack-detector";
import { SimpleGitRepositoryCloner } from "./infrastructure/simple-git-repository-cloner";
import { NodeDockerfileGenerator } from "./infrastructure/node-dockerfile-generator";
import { DockerfileGeneratorRegistry } from "./infrastructure/dockerfile-generator-registry";
import { DockerComposeOrchestrator } from "./infrastructure/docker-compose-orchestrator";
import { DockerComposeFileBuilder } from "./infrastructure/docker-compose-file-builder";
import { PortAllocator } from "./infrastructure/port-allocator";
import { ResourceBudgetCalculator } from "./infrastructure/resource-budget-calculator";
import { HttpHealthChecker } from "./infrastructure/http-health-checker";
import { PROJECT_REPOSITORY } from "./domain/project.repository";
import { STACK_DETECTOR } from "./domain/stack-detector";
import { REPOSITORY_CLONER } from "./domain/repository-cloner";
import { DOCKERFILE_GENERATOR } from "./domain/dockerfile-generator";
import { CONTAINER_ORCHESTRATOR } from "./domain/container-orchestrator";
import { HEALTH_CHECKER } from "./domain/health-checker";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";

@Module({
  imports: [GithubModule],
  controllers: [ProjectsController],
  providers: [
    PrismaService,
    ListProjectsUseCase,
    CreateProjectUseCase,
    DetectProjectStackUseCase,
    ImportProjectUseCase,
    DeployProjectUseCase,
    NodeDockerfileGenerator,
    DockerComposeFileBuilder,
    PortAllocator,
    ResourceBudgetCalculator,
    { provide: PROJECT_REPOSITORY, useClass: PrismaProjectRepository },
    { provide: STACK_DETECTOR, useClass: FileBasedStackDetector },
    { provide: REPOSITORY_CLONER, useClass: SimpleGitRepositoryCloner },
    { provide: DOCKERFILE_GENERATOR, useClass: DockerfileGeneratorRegistry },
    { provide: CONTAINER_ORCHESTRATOR, useClass: DockerComposeOrchestrator },
    { provide: HEALTH_CHECKER, useClass: HttpHealthChecker },
  ],
  exports: [PROJECT_REPOSITORY],
})
export class ProjectsModule {}
