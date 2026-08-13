import { Inject, Injectable } from "@nestjs/common";
import {
  PROJECT_DOMAIN_ALIAS_REPOSITORY,
  type ProjectDomainAliasRepository,
} from "../domain/project-domain-alias.repository";

@Injectable()
export class ListDomainAliasesUseCase {
  constructor(
    @Inject(PROJECT_DOMAIN_ALIAS_REPOSITORY) private readonly aliasRepository: ProjectDomainAliasRepository,
  ) {}

  execute(projectId: string): Promise<string[]> {
    return this.aliasRepository.findByProjectId(projectId);
  }
}
