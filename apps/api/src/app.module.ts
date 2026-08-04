import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { ApiThrottlerGuard } from "./infrastructure/api-throttler.guard";
import { HealthModule } from "./modules/health/health.module";
import { ProjectsModule } from "./modules/projects/projects.module";
import { GithubModule } from "./modules/github/github.module";
import { MonitoringModule } from "./modules/monitoring/monitoring.module";
import { TerminalModule } from "./modules/terminal/terminal.module";
import { AuthModule } from "./modules/auth/auth.module";
import { SystemServicesModule } from "./modules/system-services/system-services.module";

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    AuthModule,
    HealthModule,
    ProjectsModule,
    GithubModule,
    MonitoringModule,
    TerminalModule,
    SystemServicesModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ApiThrottlerGuard }],
})
export class AppModule {}
