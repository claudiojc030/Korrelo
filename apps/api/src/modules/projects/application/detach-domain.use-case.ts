import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { DOMAIN_PROVISIONER, type DomainProvisioner } from "../domain/domain-provisioner";
import type { Project } from "../domain/project.entity";

@Injectable()
export class DetachDomainUseCase {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    @Inject(DOMAIN_PROVISIONER) private readonly domainProvisioner: DomainProvisioner,
  ) {}

  async execute(projectId: string): Promise<Project> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(apiError("PROJECT_NOT_FOUND", `Projeto ${projectId} não encontrado`));
    }
    if (!project.customDomain) {
      throw new BadRequestException(apiError("DOMAIN_NOT_ATTACHED", "Este projeto não tem domínio anexado."));
    }

    await this.domainProvisioner.detach(project.customDomain);

    const updated = project.withDomain(null, "none");
    return this.projectRepository.save(updated);
  }
}
