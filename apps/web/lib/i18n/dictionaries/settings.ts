export interface SettingsDict {
  title: string;
  subtitle: string;
  domainSectionTitle: string;
  domainSectionDescription: string;
  domainLabel: string;
  domainPlaceholder: string;
  attachButton: string;
  detachButton: string;
  attachError: string;
  detachError: string;
  domainAttachedPrefix: string;
  domainAttachedWarning: string;
  confirmDetachTitle: string;
  confirmDetachBody: string;
  envSectionTitle: string;
  envSectionDescription: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  addVarButton: string;
  saveVarsButton: string;
  saveError: string;
  saved: string;
  showValues: string;
  hideValues: string;
  unknownError: string;
  removeVarAriaLabel: string;
}

export const settingsEn: SettingsDict = {
  title: "Settings",
  subtitle: "Everything about this Korrelo installation itself, not a specific project.",
  domainSectionTitle: "Korrelo's domain",
  domainSectionDescription:
    "Access the panel by a domain instead of the raw IP, with automatic HTTPS. Point an A record at this VPS's IP first.",
  domainLabel: "Domain",
  domainPlaceholder: "korrelo.mydomain.com",
  attachButton: "Attach",
  detachButton: "Remove domain",
  attachError: "Failed to attach the domain.",
  detachError: "Failed to remove the domain.",
  domainAttachedPrefix: "Attached: ",
  domainAttachedWarning:
    "Attached and serving HTTPS. Remember to also update KORRELO_WEB_URL and CORS_ORIGINS below to https://this-domain, and NEXT_PUBLIC_API_URL in apps/web/.env (requires a manual rebuild via SSH) so the app fully switches over.",
  confirmDetachTitle: "Remove the domain?",
  confirmDetachBody: "You'll go back to accessing Korrelo by IP only. This doesn't touch the env vars below.",
  envSectionTitle: "Korrelo's environment variables",
  envSectionDescription:
    "The Core's own apps/api/.env (JWT_SECRET, GitHub App credentials, backup alerts, etc.), not a project's variables.",
  keyPlaceholder: "KEY_NAME",
  valuePlaceholder: "value",
  addVarButton: "Add variable",
  saveVarsButton: "Save",
  saveError: "Failed to save.",
  saved: "Saved. Restart the API for it to take effect (pm2 restart korrelo-api).",
  showValues: "Show values",
  hideValues: "Hide values",
  unknownError: "Unknown error",
  removeVarAriaLabel: "Remove variable",
};

export const settingsPt: SettingsDict = {
  title: "Configurações",
  subtitle: "Tudo sobre esta instalação do Korrelo em si, não de um projeto específico.",
  domainSectionTitle: "Domínio do Korrelo",
  domainSectionDescription:
    "Acesse o painel por um domínio em vez do IP puro, com HTTPS automático. Aponte um registro A pro IP desta VPS antes.",
  domainLabel: "Domínio",
  domainPlaceholder: "korrelo.seudominio.com",
  attachButton: "Anexar",
  detachButton: "Remover domínio",
  attachError: "Falha ao anexar o domínio.",
  detachError: "Falha ao remover o domínio.",
  domainAttachedPrefix: "Anexado: ",
  domainAttachedWarning:
    "Anexado e servindo HTTPS. Lembre de também atualizar KORRELO_WEB_URL e CORS_ORIGINS abaixo pra https://esse-dominio, e o NEXT_PUBLIC_API_URL em apps/web/.env (exige rebuild manual via SSH), pra trocar completamente.",
  confirmDetachTitle: "Remover o domínio?",
  confirmDetachBody: "Você volta a acessar o Korrelo só pelo IP. Isso não mexe nas variáveis de ambiente abaixo.",
  envSectionTitle: "Variáveis de ambiente do Korrelo",
  envSectionDescription:
    "O apps/api/.env do próprio Core (JWT_SECRET, credenciais do GitHub App, alerta de backup, etc.), não as variáveis de um projeto.",
  keyPlaceholder: "NOME_DA_VARIAVEL",
  valuePlaceholder: "valor",
  addVarButton: "Adicionar variável",
  saveVarsButton: "Salvar",
  saveError: "Falha ao salvar.",
  saved: "Salvo. Reinicie a API pra valer (pm2 restart korrelo-api).",
  showValues: "Mostrar valores",
  hideValues: "Ocultar valores",
  unknownError: "Erro desconhecido",
  removeVarAriaLabel: "Remover variável",
};
