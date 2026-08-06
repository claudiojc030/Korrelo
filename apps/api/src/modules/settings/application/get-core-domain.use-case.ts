import { Inject, Injectable } from "@nestjs/common";
import { CORE_DOMAIN_REPOSITORY, type CoreDomainRepository } from "../domain/core-domain-repository";

@Injectable()
export class GetCoreDomainUseCase {
  constructor(@Inject(CORE_DOMAIN_REPOSITORY) private readonly domainRepository: CoreDomainRepository) {}

  async execute(): Promise<{ domain: string | null }> {
    return { domain: await this.domainRepository.get() };
  }
}
