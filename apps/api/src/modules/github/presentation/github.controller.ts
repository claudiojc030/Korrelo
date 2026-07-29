import { Controller, Get, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { CompleteGithubInstallationUseCase } from "../application/complete-github-installation.use-case";
import { CompleteGithubAppManifestUseCase } from "../application/complete-github-app-manifest.use-case";
import { ListGithubRepositoriesUseCase } from "../application/list-github-repositories.use-case";
import { GetGithubStatusUseCase } from "../application/get-github-status.use-case";
import { Public } from "../../auth/presentation/public.decorator";

@Controller("github")
export class GithubController {
  constructor(
    private readonly completeInstallation: CompleteGithubInstallationUseCase,
    private readonly completeAppManifest: CompleteGithubAppManifestUseCase,
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

  @Public()
  @Get("callback")
  async callback(@Query("installation_id") installationId: string, @Res() res: Response) {
    await this.completeInstallation.execute(Number(installationId));
    const webUrl = process.env.KORRELO_WEB_URL ?? "http://localhost:3000";
    res.redirect(`${webUrl}/?github=connected`);
  }

  // redirect_url do manifest (ver github-app-setup-form.tsx no frontend, que
  // monta e submete o <form manifest=...> pro github.com/settings/apps/new).
  // O GitHub volta pra cá com um "code" de uso único que trocamos pelas
  // credenciais reais do App. Já com elas salvas, manda o usuário direto pra
  // tela de instalação, sem passo manual extra.
  @Public()
  @Get("manifest-callback")
  async manifestCallback(@Query("code") code: string, @Res() res: Response) {
    const { slug } = await this.completeAppManifest.execute(code);
    res.redirect(`https://github.com/apps/${slug}/installations/new`);
  }
}
