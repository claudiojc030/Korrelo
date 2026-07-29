import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { GITHUB_APP_CLIENT, type GithubAppClient } from "../domain/github-app-client";
import {
  GITHUB_INSTALLATION_REPOSITORY,
  type GithubInstallationRepository,
} from "../domain/github-installation.repository";
import type { GithubRepositorySummary } from "../domain/github-repository-summary";

@Injectable()
export class ListGithubRepositoriesUseCase {
  constructor(
    @Inject(GITHUB_APP_CLIENT) private readonly client: GithubAppClient,
    @Inject(GITHUB_INSTALLATION_REPOSITORY) private readonly repository: GithubInstallationRepository,
  ) {}

  async execute(): Promise<GithubRepositorySummary[]> {
    const installation = await this.repository.findLatest();
    if (!installation) {
      throw new NotFoundException(apiError("GITHUB_APP_NOT_CONNECTED", "Nenhuma conta GitHub conectada ainda"));
    }
    return this.client.listInstallationRepositories(installation.installationId);
  }
}
