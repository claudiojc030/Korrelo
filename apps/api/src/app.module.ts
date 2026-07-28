import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { HealthModule } from "./modules/health/health.module";
import { ProjectsModule } from "./modules/projects/projects.module";
import { GithubModule } from "./modules/github/github.module";
import { MonitoringModule } from "./modules/monitoring/monitoring.module";
import { TerminalModule } from "./modules/terminal/terminal.module";
import { AuthModule } from "./modules/auth/auth.module";

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    AuthModule,
    HealthModule,
    ProjectsModule,
    GithubModule,
    MonitoringModule,
    TerminalModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
