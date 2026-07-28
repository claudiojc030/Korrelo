import { Module } from "@nestjs/common";
import { ProjectsController } from "./presentation/projects.controller";
import { ListProjectsUseCase } from "./application/list-projects.use-case";
import { CreateProjectUseCase } from "./application/create-project.use-case";
import { PrismaProjectRepository } from "./infrastructure/prisma-project.repository";
import { PROJECT_REPOSITORY } from "./domain/project.repository";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";

@Module({
  controllers: [ProjectsController],
  providers: [
    PrismaService,
    ListProjectsUseCase,
    CreateProjectUseCase,
    { provide: PROJECT_REPOSITORY, useClass: PrismaProjectRepository },
  ],
})
export class ProjectsModule {}
