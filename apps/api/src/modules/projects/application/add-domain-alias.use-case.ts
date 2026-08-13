import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { DOMAIN_PROVISIONER, type DomainProvisioner } from "../domain/domain-provisioner";
import {
  PROJECT_DOMAIN_ALIAS_REPOSITORY,
  type ProjectDomainAliasRepository,
} from "../domain/project-domain-alias.repository";

// Mesmo formato usado pro domínio principal (ver AttachDomainUseCase).
const DOMAIN_PATTERN = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/;

@Injectable()
export class AddDomainAliasUseCase {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    @Inject(DOMAIN_PROVISIONER) private readonly domainProvisioner: DomainProvisioner,
    @Inject(PROJECT_DOMAIN_ALIAS_REPOSITORY) private readonly aliasRepository: ProjectDomainAliasRepository,
  ) {}

  async execute(projectId: string, domain: string): Promise<string[]> {
    const normalizedDomain = domain.trim().toLowerCase();
    if (!DOMAIN_PATTERN.test(normalizedDomain)) {
      throw new BadRequestException(
        apiError(
          "INVALID_DOMAIN",
          `Domínio inválido: "${domain}". Use um hostname real, ex: www.meuapp.com (sem http://, sem porta).`,
        ),
      );
    }

    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(apiError("PROJECT_NOT_FOUND", `Projeto ${projectId} não encontrado`));
    }
    if (!project.customDomain || !project.assignedPort) {
      throw new BadRequestException(
        apiError(
          "DOMAIN_NOT_ATTACHED",
          "Anexe o domínio principal antes de adicionar domínios extras (ex.: www).",
        ),
      );
    }
    if (normalizedDomain === project.customDomain) {
      throw new ConflictException(
        apiError("DOMAIN_ALREADY_IN_USE", `"${normalizedDomain}" já é o domínio principal deste projeto.`),
      );
    }

    const existingOwner = await this.projectRepository.findByCustomDomain(normalizedDomain);
    const existingAliasOwner = await this.aliasRepository.findByDomain(normalizedDomain);
    if (existingOwner || existingAliasOwner) {
      throw new ConflictException(
        apiError("DOMAIN_ALREADY_IN_USE", `O domínio "${normalizedDomain}" já está em uso por outro projeto.`),
      );
    }

    const existingAliases = await this.aliasRepository.findByProjectId(projectId);
    const allDomains = [project.customDomain, ...existingAliases, normalizedDomain];
    await this.domainProvisioner.attach(allDomains, project.assignedPort);
    await this.aliasRepository.add(projectId, normalizedDomain);

    return [...existingAliases, normalizedDomain];
  }
}
