import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import * as path from "node:path";
import type { Project } from "../domain/project.entity";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { REPOSITORY_CLONER, type RepositoryCloner } from "../domain/repository-cloner";
import { STACK_DETECTOR, type StackDetector } from "../domain/stack-detector";
import { GITHUB_APP_CLIENT, type GithubAppClient } from "../../github/domain/github-app-client";
import {
  GITHUB_INSTALLATION_REPOSITORY,
  type GithubInstallationRepository,
} from "../../github/domain/github-installation.repository";

const WORKSPACE_DIR = process.env.FORGEDESK_WORKSPACE_DIR ?? path.join(process.cwd(), "workspace");

@Injectable()
export class ImportProjectUseCase {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly repository: ProjectRepository,
    @Inject(REPOSITORY_CLONER) private readonly cloner: RepositoryCloner,
    @Inject(STACK_DETECTOR) private readonly detector: StackDetector,
    @Inject(GITHUB_APP_CLIENT) private readonly githubAppClient: GithubAppClient,
    @Inject(GITHUB_INSTALLATION_REPOSITORY)
    private readonly githubInstallationRepository: GithubInstallationRepository,
  ) {}

  async execute(projectId: string): Promise<Project> {
    const project = await this.repository.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Projeto ${projectId} não encontrado`);
    }

    const destPath = path.join(WORKSPACE_DIR, project.id);
    const accessToken = await this.resolveGithubAccessToken();
    await this.cloner.cloneOrUpdate(project.repoUrl, destPath, accessToken);

    const detectedStack = await this.detector.detect(destPath);
    const updatedProject = project.withDetectedStack(JSON.stringify(detectedStack));
    return this.repository.save(updatedProject);
  }

  private async resolveGithubAccessToken(): Promise<string | undefined> {
    const installation = await this.githubInstallationRepository.findLatest();
    if (!installation) return undefined;

    const { token } = await this.githubAppClient.createInstallationToken(installation.installationId);
    return token;
  }
}
