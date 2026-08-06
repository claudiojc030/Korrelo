import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { CORE_DOMAIN_REPOSITORY, type CoreDomainRepository } from "../domain/core-domain-repository";
import { CORE_DOMAIN_PROVISIONER, type CoreDomainProvisioner } from "../domain/core-domain-provisioner";

// Mesmo placeholder usado pelo AttachDomainUseCase de projeto: o Korrelo não
// coleta e-mail real do administrador (login é por usuário).
const LETSENCRYPT_CONTACT_EMAIL = "admin@localhost";
const DOMAIN_PATTERN = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/;

@Injectable()
export class AttachCoreDomainUseCase {
  constructor(
    @Inject(CORE_DOMAIN_REPOSITORY) private readonly domainRepository: CoreDomainRepository,
    @Inject(CORE_DOMAIN_PROVISIONER) private readonly domainProvisioner: CoreDomainProvisioner,
  ) {}

  async execute(domain: string): Promise<{ domain: string }> {
    const normalizedDomain = domain.trim().toLowerCase();
    if (!DOMAIN_PATTERN.test(normalizedDomain)) {
      throw new BadRequestException(
        apiError(
          "INVALID_DOMAIN",
          `Domínio inválido: "${domain}". Use um hostname real, ex: meucorrelo.com (sem http://, sem porta).`,
        ),
      );
    }

    const current = await this.domainRepository.get();
    if (current) {
      throw new ConflictException(
        apiError("CORE_DOMAIN_ALREADY_ATTACHED", "O Korrelo já tem um domínio anexado. Remova antes de trocar por outro."),
      );
    }

    await this.domainProvisioner.attach(normalizedDomain, LETSENCRYPT_CONTACT_EMAIL);
    await this.domainRepository.set(normalizedDomain);
    return { domain: normalizedDomain };
  }
}
