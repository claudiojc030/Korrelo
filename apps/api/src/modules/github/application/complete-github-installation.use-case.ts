import { Inject, Injectable } from "@nestjs/common";
import { GithubInstallation } from "../domain/github-installation.entity";
import { GITHUB_APP_CLIENT, type GithubAppClient } from "../domain/github-app-client";
import {
  GITHUB_INSTALLATION_REPOSITORY,
  type GithubInstallationRepository,
} from "../domain/github-installation.repository";

@Injectable()
export class CompleteGithubInstallationUseCase {
  constructor(
    @Inject(GITHUB_APP_CLIENT) private readonly client: GithubAppClient,
    @Inject(GITHUB_INSTALLATION_REPOSITORY) private readonly repository: GithubInstallationRepository,
  ) {}

  async execute(installationId: number): Promise<GithubInstallation> {
    const accountLogin = await this.client.getInstallationAccountLogin(installationId);
    const installation = GithubInstallation.create(installationId, accountLogin);
    return this.repository.save(installation);
  }
}
