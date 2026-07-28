import { Inject, Injectable } from "@nestjs/common";
import {
  GITHUB_INSTALLATION_REPOSITORY,
  type GithubInstallationRepository,
} from "../domain/github-installation.repository";

export interface GithubStatus {
  connected: boolean;
  accountLogin: string | null;
}

@Injectable()
export class GetGithubStatusUseCase {
  constructor(
    @Inject(GITHUB_INSTALLATION_REPOSITORY) private readonly repository: GithubInstallationRepository,
  ) {}

  async execute(): Promise<GithubStatus> {
    const installation = await this.repository.findLatest();
    return {
      connected: installation !== null,
      accountLogin: installation?.accountLogin ?? null,
    };
  }
}
