export const CORE_DOMAIN_PROVISIONER = Symbol("CORE_DOMAIN_PROVISIONER");

export interface CoreDomainProvisioner {
  attach(domain: string, adminEmail: string): Promise<void>;
  detach(domain: string): Promise<void>;
}
