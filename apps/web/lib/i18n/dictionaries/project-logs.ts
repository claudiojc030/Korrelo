export interface ProjectLogsDict {
  appTab: string;
  databaseTab: string;
  autoScroll: string;
  loadLogsError: string;
  unknownError: string;
  noLogsYet: string;
  refreshEvery: string;
}

export const projectLogsEn: ProjectLogsDict = {
  appTab: "App",
  databaseTab: "Database",
  autoScroll: "Auto-scroll",
  loadLogsError: "Couldn't load logs.",
  unknownError: "Unknown error",
  noLogsYet: "No logs yet.",
  refreshEvery: "Refreshes every {seconds}s",
};

export const projectLogsPt: ProjectLogsDict = {
  appTab: "App",
  databaseTab: "Banco de Dados",
  autoScroll: "Rolagem automática",
  loadLogsError: "Falha ao carregar logs.",
  unknownError: "Erro desconhecido",
  noLogsYet: "Sem logs ainda.",
  refreshEvery: "Atualiza a cada {seconds}s",
};
