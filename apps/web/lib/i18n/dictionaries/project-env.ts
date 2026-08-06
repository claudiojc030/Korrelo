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
  pasteEnvButton: string;
  pasteEnvTitle: string;
  pasteEnvDescription: string;
  pasteEnvPlaceholder: string;
  pasteEnvImportButton: string;
  pasteEnvEmptyError: string;
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
  pasteEnvButton: "Paste a whole .env",
  pasteEnvTitle: "Paste a whole .env",
  pasteEnvDescription: "Paste the full contents of a .env file (KEY=value, one per line). Comments and blank lines are ignored; matching keys get updated, new ones are added below. Click Save afterwards for it to take effect.",
  pasteEnvPlaceholder: "DATABASE_URL=...\nAPI_KEY=...",
  pasteEnvImportButton: "Import",
  pasteEnvEmptyError: "No variables recognized. Use the KEY=value format, one per line.",
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
  pasteEnvButton: "Colar um .env inteiro",
  pasteEnvTitle: "Colar um .env inteiro",
  pasteEnvDescription: "Cole o conteúdo completo de um arquivo .env (CHAVE=valor, uma por linha). Comentários e linhas em branco são ignorados; chaves que já existem são atualizadas, as novas são adicionadas abaixo. Clica em Salvar depois pra valer.",
  pasteEnvPlaceholder: "DATABASE_URL=...\nAPI_KEY=...",
  pasteEnvImportButton: "Importar",
  pasteEnvEmptyError: "Nenhuma variável reconhecida. Use o formato CHAVE=valor, uma por linha.",
};
