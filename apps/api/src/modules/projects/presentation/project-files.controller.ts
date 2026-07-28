import { Body, Controller, Get, Param, Put, Query } from "@nestjs/common";
import { ListProjectFilesUseCase } from "../application/list-project-files.use-case";
import { ReadProjectFileUseCase } from "../application/read-project-file.use-case";
import { WriteProjectFileUseCase } from "../application/write-project-file.use-case";
import { WriteProjectFileDto } from "./write-project-file.dto";

@Controller("projects/:projectId/files")
export class ProjectFilesController {
  constructor(
    private readonly listFiles: ListProjectFilesUseCase,
    private readonly readFile: ReadProjectFileUseCase,
    private readonly writeFile: WriteProjectFileUseCase,
  ) {}

  @Get()
  list(@Param("projectId") projectId: string, @Query("path") path?: string) {
    return this.listFiles.execute(projectId, path ?? ".");
  }

  @Get("content")
  read(@Param("projectId") projectId: string, @Query("path") path: string) {
    return this.readFile.execute(projectId, path);
  }

  @Put("content")
  async write(@Param("projectId") projectId: string, @Body() dto: WriteProjectFileDto) {
    await this.writeFile.execute(projectId, dto.path, dto.content);
    return { ok: true };
  }
}
