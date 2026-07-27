import { Module } from "@nestjs/common";
import { ProjectsController } from "./presentation/projects.controller";
import { ListProjectsUseCase } from "./application/list-projects.use-case";
import { CreateProjectUseCase } from "./application/create-project.use-case";
import { InMemoryProjectRepository } from "./infrastructure/in-memory-project.repository";
import { PROJECT_REPOSITORY } from "./domain/project.repository";

@Module({
  controllers: [ProjectsController],
  providers: [
    ListProjectsUseCase,
    CreateProjectUseCase,
    { provide: PROJECT_REPOSITORY, useClass: InMemoryProjectRepository },
  ],
})
export class ProjectsModule {}
