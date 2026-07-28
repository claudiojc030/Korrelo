import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { DOMAIN_PROVISIONER, type DomainProvisioner } from "../domain/domain-provisioner";
import { USER_REPOSITORY, type UserRepository } from "../../auth/domain/user.repository";
import type { Project } from "../domain/project.entity";

// Hostname simples (sem protocolo, sem porta, sem wildcard) — o mesmo formato
// que entra no "-d" do certbot e no "server_name" do nginx.
const DOMAIN_PATTERN = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/;

@Injectable()
export class AttachDomainUseCase {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    @Inject(USER_REPOSITORY) private readonly userRepository: UserRepository,
    @Inject(DOMAIN_PROVISIONER) private readonly domainProvisioner: DomainProvisioner,
  ) {}

  async execute(projectId: string, domain: string): Promise<Project> {
    const normalizedDomain = domain.trim().toLowerCase();
    if (!DOMAIN_PATTERN.test(normalizedDomain)) {
      throw new BadRequestException(
        `Domínio inválido: "${domain}". Use um hostname real, ex: meuapp.com (sem http://, sem porta).`,
      );
    }

    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Projeto ${projectId} não encontrado`);
    }
    if (!project.assignedPort) {
      throw new BadRequestException(
        "Este projeto ainda não foi implantado — faça o deploy antes de anexar um domínio.",
      );
    }
    if (project.customDomain) {
      throw new ConflictException(
        "Este projeto já tem um domínio anexado. Remova antes de trocar por outro.",
      );
    }

    const existingOwner = await this.projectRepository.findByCustomDomain(normalizedDomain);
    if (existingOwner) {
      throw new ConflictException(`O domínio "${normalizedDomain}" já está em uso por outro projeto.`);
    }

    const admin = await this.userRepository.findFirst();
    const adminEmail = admin?.email ?? "admin@localhost";

    await this.domainProvisioner.attach(normalizedDomain, project.assignedPort, adminEmail);

    const updated = project.withDomain(normalizedDomain, "active");
    return this.projectRepository.save(updated);
  }
}
