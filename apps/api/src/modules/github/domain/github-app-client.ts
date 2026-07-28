import type { GithubRepositorySummary } from "./github-repository-summary";

export const GITHUB_APP_CLIENT = Symbol("GITHUB_APP_CLIENT");

export interface InstallationToken {
  token: string;
  expiresAt: Date;
}

export interface GithubAppClient {
  getInstallationAccountLogin(installationId: number): Promise<string>;
  createInstallationToken(installationId: number): Promise<InstallationToken>;
  listInstallationRepositories(installationId: number): Promise<GithubRepositorySummary[]>;
}
