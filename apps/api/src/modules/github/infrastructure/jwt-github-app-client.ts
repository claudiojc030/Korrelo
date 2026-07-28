import { Injectable, InternalServerErrorException } from "@nestjs/common";
import jwt from "jsonwebtoken";
import type { GithubAppClient, InstallationToken } from "../domain/github-app-client";
import type { GithubRepositorySummary } from "../domain/github-repository-summary";

interface GithubApiInstallation {
  account: { login: string };
}

interface GithubApiInstallationToken {
  token: string;
  expires_at: string;
}

interface GithubApiRepository {
  full_name: string;
  private: boolean;
  default_branch: string;
  clone_url: string;
}

@Injectable()
export class JwtGithubAppClient implements GithubAppClient {
  private get appId(): string {
    const value = process.env.GITHUB_APP_ID;
    if (!value) throw new InternalServerErrorException("GITHUB_APP_ID não configurado");
    return value;
  }

  private get privateKey(): string {
    const value = process.env.GITHUB_APP_PRIVATE_KEY;
    if (!value) throw new InternalServerErrorException("GITHUB_APP_PRIVATE_KEY não configurado");
    return value.replace(/\\n/g, "\n");
  }

  async getInstallationAccountLogin(installationId: number): Promise<string> {
    const appJwt = this.signAppJwt();
    const data = await this.githubApiFetch<GithubApiInstallation>(
      `/app/installations/${installationId}`,
      appJwt,
    );
    return data.account.login;
  }

  async createInstallationToken(installationId: number): Promise<InstallationToken> {
    const appJwt = this.signAppJwt();
    const data = await this.githubApiFetch<GithubApiInstallationToken>(
      `/app/installations/${installationId}/access_tokens`,
      appJwt,
      { method: "POST" },
    );
    return { token: data.token, expiresAt: new Date(data.expires_at) };
  }

  async listInstallationRepositories(installationId: number): Promise<GithubRepositorySummary[]> {
    const { token } = await this.createInstallationToken(installationId);
    const data = await this.githubApiFetch<{ repositories: GithubApiRepository[] }>(
      "/installation/repositories",
      token,
    );
    return data.repositories.map((repo) => ({
      fullName: repo.full_name,
      private: repo.private,
      defaultBranch: repo.default_branch,
      cloneUrl: repo.clone_url,
    }));
  }

  private signAppJwt(): string {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return jwt.sign(
      { iat: nowSeconds - 60, exp: nowSeconds + 600, iss: this.appId },
      this.privateKey,
      { algorithm: "RS256" },
    );
  }

  private async githubApiFetch<T>(path: string, bearerToken: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...init.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new InternalServerErrorException(`Erro na API do GitHub (${res.status}): ${body}`);
    }

    return res.json() as Promise<T>;
  }
}
