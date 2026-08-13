export const DOMAIN_PROVISIONER = Symbol("DOMAIN_PROVISIONER");

export interface DomainProvisioner {
  // Escreve o site do nginx apontando pro projeto e emite/expande o
  // certificado Let's Encrypt via certbot cobrindo TODOS os domínios da
  // lista (principal + aliases, ex.: www) - sempre a lista inteira desejada,
  // nunca só o que mudou, porque certbot --expand e o server_name do nginx
  // precisam do conjunto completo pra ficarem corretos. Lança se qualquer
  // etapa falhar (o use case decide o que fazer com o registro no banco
  // quando isso acontece).
  attach(domains: string[], port: number): Promise<void>;

  // Remove o site do nginx inteiro (o certificado emitido fica no disco, não
  // revogamos, só paramos de servir por ele).
  detach(domains: string[]): Promise<void>;

  // Só reescreve o server_name do nginx com a lista atual (ex.: depois de
  // remover um alias) e recarrega - SEM chamar o certbot de novo. Encolher a
  // lista de domínios de um certificado já emitido não é uma operação segura
  // via -d/--expand (pensado só pra crescer); um domínio a mais no
  // certificado sem rota nenhuma pra ele é inofensivo, só fica sem uso até a
  // próxima renovação natural.
  updateServerNames(domains: string[]): Promise<void>;
}
