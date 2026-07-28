import type { GithubInstallation } from "./github-installation.entity";

export const GITHUB_INSTALLATION_REPOSITORY = Symbol("GITHUB_INSTALLATION_REPOSITORY");

export interface GithubInstallationRepository {
  findLatest(): Promise<GithubInstallation | null>;
  save(installation: GithubInstallation): Promise<GithubInstallation>;
}
