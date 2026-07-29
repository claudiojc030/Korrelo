export interface SystemServicesDict {
  loading: string;
  pageTitle: string;
  pageDescription: string;
  riskLow: string;
  riskMedium: string;
  riskHigh: string;
  notPresent: string;
  disableEffectLabel: string;
  errorToggleFailed: string;
  errorUnknown: string;
  applying: string;
}

export const systemServicesEn: SystemServicesDict = {
  loading: "Loading...",
  pageTitle: "Server services",
  pageDescription:
    "Operating system services that a VPS running only Korrelo usually doesn't need. This is a closed, reviewed list, so essential services (SSH, Docker, nginx, etc) can never be toggled here.",
  riskLow: "Low risk",
  riskMedium: "Medium risk",
  riskHigh: "High risk",
  notPresent: "Not present on this VPS",
  disableEffectLabel: "If disabled:",
  errorToggleFailed: "Couldn't update the service.",
  errorUnknown: "Unknown error",
  applying: "Applying...",
};

export const systemServicesPt: SystemServicesDict = {
  loading: "Carregando...",
  pageTitle: "Serviços do servidor",
  pageDescription:
    "Serviços do sistema operacional que uma VPS rodando só o Korrelo normalmente não precisa. Lista fechada e revisada, nunca dá pra mexer em serviços essenciais (SSH, Docker, nginx, etc.) por aqui.",
  riskLow: "Risco baixo",
  riskMedium: "Risco médio",
  riskHigh: "Risco alto",
  notPresent: "Não presente nesta VPS",
  disableEffectLabel: "Se desativar:",
  errorToggleFailed: "Falha ao atualizar o serviço.",
  errorUnknown: "Erro desconhecido",
  applying: "Aplicando...",
};
