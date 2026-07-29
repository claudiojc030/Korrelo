export interface ProjectEnvDict {
  title: string;
  subtitle: string;
  showValues: string;
  hideValues: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  removeVarAriaLabel: string;
  addVarButton: string;
  saveError: string;
  unknownError: string;
  saved: string;
}

export const projectEnvEn: ProjectEnvDict = {
  title: "Environment variables",
  subtitle: "Applied on the next deploy, you need to Deploy again for it to take effect on the running container.",
  showValues: "Show values",
  hideValues: "Hide values",
  keyPlaceholder: "VARIABLE_NAME",
  valuePlaceholder: "value",
  removeVarAriaLabel: "Remove variable",
  addVarButton: "Add variable",
  saveError: "Failed to save.",
  unknownError: "Unknown error",
  saved: "Saved.",
};

export const projectEnvPt: ProjectEnvDict = {
  title: "Variáveis de ambiente",
  subtitle: "Aplicadas no próximo deploy, precisa dar Deploy de novo pra valer pro container já rodando.",
  showValues: "Mostrar valores",
  hideValues: "Ocultar valores",
  keyPlaceholder: "NOME_DA_VARIAVEL",
  valuePlaceholder: "valor",
  removeVarAriaLabel: "Remover variável",
  addVarButton: "Adicionar variável",
  saveError: "Falha ao salvar.",
  unknownError: "Erro desconhecido",
  saved: "Salvo.",
};
