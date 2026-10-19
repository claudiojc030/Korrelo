import { Inject, Injectable, Logger } from "@nestjs/common";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { DeployQueueService } from "../infrastructure/deploy-queue.service";

export interface GithubPushEvent {
  repositoryCloneUrl: string;
  ref: string; // ex: "refs/heads/main"
  /**
   * Commit empurrado (payload "after" do GitHub). Quando vem, o deploy
   * usa ESSE commit - e não "a head da branch no momento do build" - o que
   * torna o deploy determinístico (nunca implanta um commit diferente do
   * registrado no job).
   */
  commitSha?: string | null;
}

@Injectable()
export class HandleGithubPushWebhookUseCase {
  private readonly logger = new Logger(HandleGithubPushWebhookUseCase.name);

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    private readonly deployQueue: DeployQueueService,
  ) {}

  /**
   * Só ENFILEIRA. O webhook responde pro GitHub em milissegundos e o worker
   * roda o build depois (um por vez na VPS inteira).
   *
   * Pushes seguidos se COALESCEM na fila: se o job anterior ainda está
   * "queued" (não começou), ele é cancelado e o commit novo assume. Job já
   * iniciado nunca é cancelado, e cada job tem UM commit.
   */
  async execute(event: GithubPushEvent): Promise<{ triggered: string[]; jobs: string[] }> {
    const pushedBranch = event.ref.replace(/^refs\/heads\//, "");
    const candidates = await this.projectRepository.findByRepoUrl(event.repositoryCloneUrl);

    const triggered: string[] = [];
    const jobs: string[] = [];

    for (const project of candidates) {
      if (!project.autoDeployEnabled) continue;
      if (project.deployBranch !== pushedBranch) continue;

      const { job } = await this.deployQueue.enqueue({
        projectId: project.id,
        commitSha: event.commitSha ?? null,
        branch: pushedBranch,
        trigger: "webhook",
      });

      triggered.push(project.id);
      jobs.push(job.id);
      this.logger.log(
        `Push em "${pushedBranch}" (${event.commitSha?.slice(0, 7) ?? "?"}) enfileirado pro projeto "${project.name}" (job ${job.id})`,
      );
    }

    return { triggered, jobs };
  }
}
