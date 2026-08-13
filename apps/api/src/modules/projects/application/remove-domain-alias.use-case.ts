import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { DOMAIN_PROVISIONER, type DomainProvisioner } from "../domain/domain-provisioner";
import {
  PROJECT_DOMAIN_ALIAS_REPOSITORY,
  type ProjectDomainAliasRepository,
} from "../domain/project-domain-alias.repository";

@Injectable()
export class RemoveDomainAliasUseCase {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    @Inject(DOMAIN_PROVISIONER) private readonly domainProvisioner: DomainProvisioner,
    @Inject(PROJECT_DOMAIN_ALIAS_REPOSITORY) private readonly aliasRepository: ProjectDomainAliasRepository,
  ) {}

  async execute(projectId: string, domain: string): Promise<string[]> {
    const normalizedDomain = domain.trim().toLowerCase();
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(apiError("PROJECT_NOT_FOUND", `Projeto ${projectId} não encontrado`));
    }
    if (!project.customDomain) {
      throw new BadRequestException(apiError("DOMAIN_NOT_ATTACHED", "Este projeto não tem domínio anexado."));
    }

    const existingAliases = await this.aliasRepository.findByProjectId(projectId);
    if (!existingAliases.includes(normalizedDomain)) {
      throw new BadRequestException(apiError("DOMAIN_ALIAS_NOT_FOUND", `"${normalizedDomain}" não é um domínio extra deste projeto.`));
    }

    const remainingAliases = existingAliases.filter((alias) => alias !== normalizedDomain);
    await this.domainProvisioner.updateServerNames([project.customDomain, ...remainingAliases]);
    await this.aliasRepository.remove(projectId, normalizedDomain);

    return remainingAliases;
  }
}
