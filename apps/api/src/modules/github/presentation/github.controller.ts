import { Controller, Get, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { CompleteGithubInstallationUseCase } from "../application/complete-github-installation.use-case";
import { ListGithubRepositoriesUseCase } from "../application/list-github-repositories.use-case";
import { GetGithubStatusUseCase } from "../application/get-github-status.use-case";

@Controller("github")
export class GithubController {
  constructor(
    private readonly completeInstallation: CompleteGithubInstallationUseCase,
    private readonly listRepositories: ListGithubRepositoriesUseCase,
    private readonly getStatus: GetGithubStatusUseCase,
  ) {}

  @Get("install-url")
  getInstallUrl() {
    const slug = process.env.GITHUB_APP_SLUG;
    return { url: `https://github.com/apps/${slug}/installations/new` };
  }

  @Get("status")
  status() {
    return this.getStatus.execute();
  }

  @Get("repositories")
  repositories() {
    return this.listRepositories.execute();
  }

  @Get("callback")
  async callback(@Query("installation_id") installationId: string, @Res() res: Response) {
    await this.completeInstallation.execute(Number(installationId));
    const webUrl = process.env.FORGEDESK_WEB_URL ?? "http://localhost:3000";
    res.redirect(`${webUrl}/?github=connected`);
  }
}
