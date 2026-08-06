export const CORE_DOMAIN_REPOSITORY = Symbol("CORE_DOMAIN_REPOSITORY");

export interface CoreDomainRepository {
  get(): Promise<string | null>;
  set(domain: string | null): Promise<void>;
}
