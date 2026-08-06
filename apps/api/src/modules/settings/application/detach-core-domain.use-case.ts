import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { CORE_DOMAIN_REPOSITORY, type CoreDomainRepository } from "../domain/core-domain-repository";
import { CORE_DOMAIN_PROVISIONER, type CoreDomainProvisioner } from "../domain/core-domain-provisioner";

@Injectable()
export class DetachCoreDomainUseCase {
  constructor(
    @Inject(CORE_DOMAIN_REPOSITORY) private readonly domainRepository: CoreDomainRepository,
    @Inject(CORE_DOMAIN_PROVISIONER) private readonly domainProvisioner: CoreDomainProvisioner,
  ) {}

  async execute(): Promise<void> {
    const current = await this.domainRepository.get();
    if (!current) {
      throw new BadRequestException(apiError("CORE_DOMAIN_NOT_ATTACHED", "O Korrelo não tem domínio anexado."));
    }

    await this.domainProvisioner.detach(current);
    await this.domainRepository.set(null);
  }
}
