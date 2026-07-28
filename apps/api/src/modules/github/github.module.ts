import { Module } from "@nestjs/common";
import { GithubController } from "./presentation/github.controller";
import { CompleteGithubInstallationUseCase } from "./application/complete-github-installation.use-case";
import { ListGithubRepositoriesUseCase } from "./application/list-github-repositories.use-case";
import { GetGithubStatusUseCase } from "./application/get-github-status.use-case";
import { JwtGithubAppClient } from "./infrastructure/jwt-github-app-client";
import { PrismaGithubInstallationRepository } from "./infrastructure/prisma-github-installation.repository";
import { GITHUB_APP_CLIENT } from "./domain/github-app-client";
import { GITHUB_INSTALLATION_REPOSITORY } from "./domain/github-installation.repository";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";

@Module({
  controllers: [GithubController],
  providers: [
    PrismaService,
    CompleteGithubInstallationUseCase,
    ListGithubRepositoriesUseCase,
    GetGithubStatusUseCase,
    { provide: GITHUB_APP_CLIENT, useClass: JwtGithubAppClient },
    { provide: GITHUB_INSTALLATION_REPOSITORY, useClass: PrismaGithubInstallationRepository },
  ],
  exports: [GITHUB_APP_CLIENT, GITHUB_INSTALLATION_REPOSITORY],
})
export class GithubModule {}
