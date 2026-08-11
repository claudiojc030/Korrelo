import { Inject, Injectable, Logger } from "@nestjs/common";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { DeployProjectUseCase } from "./deploy-project.use-case";

export interface GithubPushEvent {
  repositoryCloneUrl: string;
  ref: string; // ex: "refs/heads/main"
}

// Vários commits seguidos (comum ao iterar rápido) cada um dispara seu
// próprio webhook. Sem isso, cada push virava um deploy inteiro na fila
// (DeployProjectUseCase.deployQueues), inclusive de commits já superados -
// minutos de espera acumulados pra só o último importar de verdade.
const DEBOUNCE_MS = 10_000;

@Injectable()
export class HandleGithubPushWebhookUseCase {
  private readonly logger = new Logger(HandleGithubPushWebhookUseCase.name);
  private readonly pendingDeploys = new Map<string, NodeJS.Timeout>();

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

      const existingTimer = this.pendingDeploys.get(project.id);
      if (existingTimer) clearTimeout(existingTimer);

      const timer = setTimeout(() => {
        this.pendingDeploys.delete(project.id);
        // Não espera o deploy terminar, porque um build pode levar minutos, e
        // o GitHub considera a entrega do webhook falha depois de ~10s sem resposta.
        this.deployProject.execute(project.id, "webhook").catch((error) => {
          this.logger.error(`Auto-deploy falhou pro projeto "${project.name}" (${project.id}): ${error}`);
        });
      }, DEBOUNCE_MS);
      this.pendingDeploys.set(project.id, timer);
    }

    return { triggered };
  }
}
