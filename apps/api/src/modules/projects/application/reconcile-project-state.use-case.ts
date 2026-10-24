import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { CONTAINER_ORCHESTRATOR, type ContainerOrchestrator } from "../domain/container-orchestrator";
import type { Project } from "../domain/project.entity";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";

/**
 * RECONCILIAÇÃO EXPLÍCITA de um projeto em ESTADO INDETERMINADO.
 *
 * O bloqueio de novos deploys só é removido quando o estado real do container
 * é comprovado. Regras:
 *  - só age se `lastDeployStatus === "indeterminate"` (nunca "conserta" um
 *    projeto saudável);
 *  - sem container de produção, apenas libera o bloqueio mantendo o deploy
 *    anterior como falho;
 *  - container com identidade NÃO comprovável -> recusa (nada muda);
 *  - container comprovado -> registra a imagem realmente em execução
 *    (adoção observada) e devolve o projeto ao estado de runtime coerente.
 *
 * NÃO executa `docker compose`, não reinicia container e não publica compose.
 */
@Injectable()
export class ReconcileProjectStateUseCase {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly repository: ProjectRepository,
    @Inject(CONTAINER_ORCHESTRATOR) private readonly orchestrator: ContainerOrchestrator,
  ) {}

  async execute(projectId: string): Promise<Project> {
    const project = await this.repository.findById(projectId);
    if (!project) {
      throw new NotFoundException(apiError("PROJECT_NOT_FOUND", `Projeto ${projectId} não encontrado`));
    }
    if (project.lastDeployStatus !== "indeterminate") {
      throw new BadRequestException(
        apiError(
          "PROJECT_NOT_INDETERMINATE",
          "Este projeto não está em estado indeterminado; não há reconciliação pendente.",
        ),
      );
    }

    if (!project.containerName) {
      return this.repository.save(project.withLastDeployStatus("failed"));
    }

    const state = await this.orchestrator.inspectProductionContainer(project.containerName);
    if (state.kind === "unverified") {
      throw new ConflictException(
        apiError(
          "PROJECT_RECONCILE_UNVERIFIED",
          `Não foi possível comprovar a imagem do container "${project.containerName}": ${state.reason}. ` +
            "Nada foi alterado. Verifique o container manualmente e tente novamente.",
        ),
      );
    }

    if (state.kind === "absent") {
      // Sem produção observada: libera o bloqueio, mantendo o último deploy
      // como falho (não há imagem para registrar).
      return this.repository.save(project.withLastDeployStatus("failed"));
    }

    // Só aceita referência versionada do próprio projeto, como no gate de
    // promoção; nada de "latest" nem tag de outro repositório.
    const parsed = parseImageReference(state.imageReference);
    if (!parsed || parsed.tag === "latest") {
      throw new ConflictException(
        apiError(
          "PROJECT_RECONCILE_REFERENCE",
          `A imagem em execução ("${state.imageReference}") não é uma tag versionada (commit-*). ` +
            "Nada foi alterado; publique uma versão tagueada antes de reconciliar.",
        ),
      );
    }

    let reconciled = project
      .withImages(state.imageReference, project.previousImage)
      .withLastDeployStatus("failed");
    if (project.assignedPort !== null) {
      reconciled = reconciled.withDeployment(project.containerName, project.assignedPort);
    }
    return this.repository.save(reconciled);
  }
}

/** "repo:tag" -> { name, tag }; null para IDs/digests/referências inválidas. */
function parseImageReference(reference: string): { name: string; tag: string } | null {
  const index = reference.lastIndexOf(":");
  if (index <= 0) return null;
  const name = reference.slice(0, index);
  const tag = reference.slice(index + 1);
  if (!name || !tag || tag.includes("/") || name.startsWith("sha256")) return null;
  return { name, tag };
}
