import { Inject, Injectable, Logger } from "@nestjs/common";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { DeployProjectUseCase } from "./deploy-project.use-case";

export interface GithubPushEvent {
  repositoryCloneUrl: string;
  ref: string; // ex: "refs/heads/main"
}

@Injectable()
export class HandleGithubPushWebhookUseCase {
  private readonly logger = new Logger(HandleGithubPushWebhookUseCase.name);

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    private readonly deployProject: DeployProjectUseCase,
  ) {}

  async execute(event: GithubPushEvent): Promise<{ triggered: string[] }> {
    const pushedBranch = event.ref.replace(/^refs\/heads\//, "");
    const candidates = await this.projectRepository.findByRepoUrl(event.repositoryCloneUrl);

    const triggered: string[] = [];
    for (const project of candidates) {
      if (!project.autoDeployEnabled) continue;
      if (project.deployBranch !== pushedBranch) continue;

      triggered.push(project.id);
      // Não espera o deploy terminar — um build pode levar minutos, e o
      // GitHub considera a entrega do webhook falha depois de ~10s sem resposta.
      this.deployProject.execute(project.id).catch((error) => {
        this.logger.error(`Auto-deploy falhou pro projeto "${project.name}" (${project.id}): ${error}`);
      });
    }

    return { triggered };
  }
}
