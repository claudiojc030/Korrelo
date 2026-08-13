export const PROJECT_DOMAIN_ALIAS_REPOSITORY = Symbol("PROJECT_DOMAIN_ALIAS_REPOSITORY");

export interface ProjectDomainAliasRepository {
  findByProjectId(projectId: string): Promise<string[]>;
  findByDomain(domain: string): Promise<{ projectId: string } | null>;
  add(projectId: string, domain: string): Promise<void>;
  remove(projectId: string, domain: string): Promise<void>;
  removeAllByProjectId(projectId: string): Promise<void>;
}
