import { Module } from "@nestjs/common";
import { HealthModule } from "./modules/health/health.module";
import { ProjectsModule } from "./modules/projects/projects.module";

@Module({
  imports: [HealthModule, ProjectsModule],
})
export class AppModule {}
