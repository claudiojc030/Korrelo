import { Module } from "@nestjs/common";
import { ProjectsController } from "./presentation/projects.controller";
import { ListProjectsUseCase } from "./application/list-projects.use-case";
import { CreateProjectUseCase } from "./application/create-project.use-case";
import { DetectProjectStackUseCase } from "./application/detect-project-stack.use-case";
import { PrismaProjectRepository } from "./infrastructure/prisma-project.repository";
import { FileBasedStackDetector } from "./infrastructure/file-based-stack-detector";
import { PROJECT_REPOSITORY } from "./domain/project.repository";
import { STACK_DETECTOR } from "./domain/stack-detector";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";

@Module({
  controllers: [ProjectsController],
  providers: [
    PrismaService,
    ListProjectsUseCase,
    CreateProjectUseCase,
    DetectProjectStackUseCase,
    { provide: PROJECT_REPOSITORY, useClass: PrismaProjectRepository },
    { provide: STACK_DETECTOR, useClass: FileBasedStackDetector },
  ],
})
export class ProjectsModule {}
