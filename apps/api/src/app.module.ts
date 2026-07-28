import { Module } from "@nestjs/common";
import { HealthModule } from "./modules/health/health.module";
import { ProjectsModule } from "./modules/projects/projects.module";
import { GithubModule } from "./modules/github/github.module";

@Module({
  imports: [HealthModule, ProjectsModule, GithubModule],
})
export class AppModule {}
