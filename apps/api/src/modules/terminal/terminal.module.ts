import { Module } from "@nestjs/common";
import { ProjectsModule } from "../projects/projects.module";
import { AuthModule } from "../auth/auth.module";
import { TerminalGateway } from "./presentation/terminal.gateway";
import { DockerExecShellSessionFactory } from "./infrastructure/docker-exec-shell-session";
import { SHELL_SESSION_FACTORY } from "./domain/shell-session";

@Module({
  imports: [ProjectsModule, AuthModule],
  providers: [
    TerminalGateway,
    { provide: SHELL_SESSION_FACTORY, useClass: DockerExecShellSessionFactory },
  ],
})
export class TerminalModule {}
