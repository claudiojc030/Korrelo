import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ResolveDeployCommitUseCase } from "./resolve-deploy-commit.use-case";
import type { ProjectRepository } from "../domain/project.repository";
import type { RepositoryCloner } from "../domain/repository-cloner";
import type { GithubAppClient } from "../../github/domain/github-app-client";
import type { GithubInstallationRepository } from "../../github/domain/github-installation.repository";

const SHA = "a".repeat(40);

function useCase(options: {
  project?: { repoUrl: string; deployBranch: string } | null;
  resolved?: string | null;
  tokenError?: boolean;
} = {}) {
  const project =
    options.project === undefined
      ? { repoUrl: "https://github.com/acme/app.git", deployBranch: "main" }
      : options.project;
  const repository = {
    findById: jest.fn().mockResolvedValue(project),
  } as unknown as ProjectRepository;
  const cloner = {
    resolveBranchHead: jest
      .fn()
      .mockResolvedValue(options.resolved === undefined ? SHA : options.resolved),
  } as unknown as RepositoryCloner;
  const githubAppClient = {
    createInstallationToken: options.tokenError
      ? jest.fn().mockRejectedValue(new Error("token falhou"))
      : jest.fn().mockResolvedValue({ token: "t", expiresAt: new Date() }),
  } as unknown as GithubAppClient;
  const installations = {
    findLatest: jest.fn().mockResolvedValue({ installationId: 1 }),
  } as unknown as GithubInstallationRepository;
  return new ResolveDeployCommitUseCase(repository, cloner, githubAppClient, installations);
}

describe("ResolveDeployCommitUseCase", () => {
  it("resolve o SHA completo da branch sem clonar nem usar Docker", async () => {
    const result = await useCase().execute("proj-1");

    expect(result).toEqual({
      branch: "main",
      commitSha: SHA,
      shortSha: SHA.slice(0, 7),
      message: null,
      committedAt: null,
      source: "git-ls-remote",
    });
  });

  it("projeto inexistente é 404", async () => {
    await expect(useCase({ project: null }).execute("x")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("branch ausente falha explicitamente", async () => {
    await expect(
      useCase({ project: { repoUrl: "https://github.com/acme/app.git", deployBranch: "" } }).execute(
        "proj-1",
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("branch sem commit descoberto não inventa SHA", async () => {
    await expect(useCase({ resolved: null }).execute("proj-1")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("falha ao obter token ainda tenta a descoberta (repositório público)", async () => {
    const result = await useCase({ tokenError: true }).execute("proj-1");
    expect(result.commitSha).toBe(SHA);
  });
});
