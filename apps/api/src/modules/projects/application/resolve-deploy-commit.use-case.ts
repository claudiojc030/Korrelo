import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { REPOSITORY_CLONER, type RepositoryCloner } from "../domain/repository-cloner";
import {
  GITHUB_APP_CLIENT,
  type GithubAppClient,
} from "../../github/domain/github-app-client";
import {
  GITHUB_INSTALLATION_REPOSITORY,
  type GithubInstallationRepository,
} from "../../github/domain/github-installation.repository";

export interface ResolvedDeployCommit {
  branch: string;
  commitSha: string;
  shortSha: string;
  /** Mensagem/data não vêm do ls-remote; ficam nulas em vez de inventadas. */
  message: null;
  committedAt: null;
  source: "git-ls-remote";
}

/**
 * Descobre o HEAD da branch de deploy SEM Docker, sem build e sem deploy.
 * Somente leitura remota (`git ls-remote`). Falha explícita em vez de devolver
 * um SHA inventado.
 */
@Injectable()
export class ResolveDeployCommitUseCase {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly repository: ProjectRepository,
    @Inject(REPOSITORY_CLONER) private readonly cloner: RepositoryCloner,
    @Inject(GITHUB_APP_CLIENT) private readonly githubAppClient: GithubAppClient,
    @Inject(GITHUB_INSTALLATION_REPOSITORY)
    private readonly githubInstallationRepository: GithubInstallationRepository,
  ) {}

  async execute(projectId: string): Promise<ResolvedDeployCommit> {
    const project = await this.repository.findById(projectId);
    if (!project) throw new NotFoundException(`Projeto ${projectId} não encontrado`);

    const branch = (project.deployBranch ?? "").trim();
    if (!branch) {
      throw new ServiceUnavailableException("Branch de deploy não configurada para este projeto.");
    }

    let token: string | undefined;
    try {
      const installation = await this.githubInstallationRepository.findLatest();
      if (installation) {
        token = (await this.githubAppClient.createInstallationToken(installation.installationId)).token;
      }
    } catch {
      // Sem token, tenta repositório público. Nunca inventa resultado.
      token = undefined;
    }

    const commitSha = await this.cloner.resolveBranchHead(project.repoUrl, branch, token);
    if (!commitSha) {
      throw new ServiceUnavailableException(
        "Não foi possível descobrir o HEAD da branch agora. Informe o SHA completo manualmente.",
      );
    }

    return {
      branch,
      commitSha,
      shortSha: commitSha.slice(0, 7),
      message: null,
      committedAt: null,
      source: "git-ls-remote",
    };
  }
}
