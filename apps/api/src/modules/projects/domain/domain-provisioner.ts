export const DOMAIN_PROVISIONER = Symbol("DOMAIN_PROVISIONER");

export interface DomainProvisioner {
  // Escreve o site do nginx apontando pro projeto e emite o certificado
  // Let's Encrypt via certbot. Lança se qualquer etapa falhar (o use case
  // decide o que fazer com o registro no banco quando isso acontece).
  attach(domain: string, port: number, adminEmail: string): Promise<void>;

  // Remove o site do nginx (o certificado emitido fica no disco, não
  // revogamos, só paramos de servir por ele).
  detach(domain: string): Promise<void>;
}
