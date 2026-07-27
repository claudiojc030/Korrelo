import { Body, Controller, Get, Post } from "@nestjs/common";
import { ListProjectsUseCase } from "../application/list-projects.use-case";
import { CreateProjectUseCase } from "../application/create-project.use-case";
import { CreateProjectDto } from "./create-project.dto";

@Controller("projects")
export class ProjectsController {
  constructor(
    private readonly listProjects: ListProjectsUseCase,
    private readonly createProject: CreateProjectUseCase,
  ) {}

  @Get()
  list() {
    return this.listProjects.execute();
  }

  @Post()
  create(@Body() dto: CreateProjectDto) {
    return this.createProject.execute(dto);
  }
}
