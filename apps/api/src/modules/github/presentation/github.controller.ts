import { BadRequestException, Controller, Get, Param, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { apiError } from "../../../infrastructure/api-error";
import { CompleteGithubInstallationUseCase } from "../application/complete-github-installation.use-case";
import { CompleteGithubAppManifestUseCase } from "../application/complete-github-app-manifest.use-case";
import { ListGithubRepositoriesUseCase } from "../application/list-github-repositories.use-case";
import { GetGithubStatusUseCase } from "../application/get-github-status.use-case";
import { signGithubFlowState, verifyGithubFlowState } from "../infrastructure/github-flow-state";

const INSTALL_STATE_PURPOSE = "github-app-install";
const MANIFEST_STATE_PURPOSE = "github-app-manifest";

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
    const state = signGithubFlowState(INSTALL_STATE_PURPOSE);
    return { url: `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}` };
  }

  // Emite o token que o frontend embute no redirect_url do manifest (ver
  // github-connect-button.tsx). Exige sessão autenticada de propósito: é isso
  // que garante que só quem clicou "Criar GitHub App" logado no Korrelo
  // consiga completar o fluxo depois, em vez de qualquer link que alguém
  // mande pra rota pública de callback (ver comentário lá).
  @Get("manifest-state")
  getManifestState() {
    return { state: signGithubFlowState(MANIFEST_STATE_PURPOSE) };
  }

  @Get("status")
  status() {
    return this.getStatus.execute();
  }

  @Get("repositories")
  repositories() {
    return this.listRepositories.execute();
  }

  // O cookie de sessão (SameSite=Lax) sozinho não prova que essa requisição
  // veio de um redirect de verdade do GitHub: ele é enviado em QUALQUER
  // navegação de topo, inclusive um link forjado por um atacante que a pessoa
  // clique estando logada. Por isso o "state" (emitido só por /install-url,
  // que exige sessão) é a defesa real aqui: sem um state válido, um
  // installation_id de outra conta não é aceito mesmo com cookie válido.
  @Get("callback")
  async callback(
    @Query("installation_id") installationId: string,
    @Query("state") state: string | undefined,
    @Res() res: Response,
  ) {
    if (!verifyGithubFlowState(state, INSTALL_STATE_PURPOSE)) {
      throw new BadRequestException(apiError("GITHUB_STATE_INVALID", "Link de instalação do GitHub inválido ou expirado."));
    }
    await this.completeInstallation.execute(Number(installationId));
    const webUrl = process.env.KORRELO_WEB_URL ?? "http://localhost:3000";
    res.redirect(`${webUrl}/?github=connected`);
  }

  // redirect_url do manifest (ver github-connect-button.tsx no frontend, que
  // busca o state em /manifest-state, monta e submete o <form manifest=...>
  // pro github.com/settings/apps/new). Mesmo raciocínio do /callback acima:
  // o state garante que só a sessão que iniciou esse fluxo consegue
  // completá-lo, mesmo que o "code" em si seja de um App qualquer.
  //
  // O state vai no CAMINHO da URL, não em query string: o GitHub valida o
  // redirect_url do manifest e rejeita qualquer um que tenha "?" (erro
  // "redirect_url must be a valid URL"), mesmo sendo uma URL sintaticamente
  // válida. O "code" continua vindo em query string porque quem adiciona
  // ele lá é o próprio GitHub, depois que já validou nosso redirect_url.
  @Get("manifest-callback/:state")
  async manifestCallback(
    @Query("code") code: string,
    @Param("state") state: string | undefined,
    @Res() res: Response,
  ) {
    if (!verifyGithubFlowState(state, MANIFEST_STATE_PURPOSE)) {
      throw new BadRequestException(apiError("GITHUB_STATE_INVALID", "Link de criação do GitHub App inválido ou expirado."));
    }
    const { slug } = await this.completeAppManifest.execute(code);
    const installState = signGithubFlowState(INSTALL_STATE_PURPOSE);
    res.redirect(`https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(installState)}`);
  }
}
