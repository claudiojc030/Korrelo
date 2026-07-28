import { Module } from "@nestjs/common";
import { ProjectsController } from "./presentation/projects.controller";
import { ListProjectsUseCase } from "./application/list-projects.use-case";
import { CreateProjectUseCase } from "./application/create-project.use-case";
import { DetectProjectStackUseCase } from "./application/detect-project-stack.use-case";
import { ImportProjectUseCase } from "./application/import-project.use-case";
import { PrismaProjectRepository } from "./infrastructure/prisma-project.repository";
import { FileBasedStackDetector } from "./infrastructure/file-based-stack-detector";
import { SimpleGitRepositoryCloner } from "./infrastructure/simple-git-repository-cloner";
import { PROJECT_REPOSITORY } from "./domain/project.repository";
import { STACK_DETECTOR } from "./domain/stack-detector";
import { REPOSITORY_CLONER } from "./domain/repository-cloner";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";

@Module({
  controllers: [ProjectsController],
  providers: [
    PrismaService,
    ListProjectsUseCase,
    CreateProjectUseCase,
    DetectProjectStackUseCase,
    ImportProjectUseCase,
    { provide: PROJECT_REPOSITORY, useClass: PrismaProjectRepository },
    { provide: STACK_DETECTOR, useClass: FileBasedStackDetector },
    { provide: REPOSITORY_CLONER, useClass: SimpleGitRepositoryCloner },
  ],
})
export class ProjectsModule {}
