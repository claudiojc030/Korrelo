export interface ProjectTerminalDict {
  disabledTitle: string;
  disabledDescription: string;
  connectionErrorPrefix: string;
  sessionEnded: string;
}

export const projectTerminalEn: ProjectTerminalDict = {
  disabledTitle: "Terminal disabled for this project",
  disabledDescription: "Turn it back on in the Settings tab.",
  connectionErrorPrefix: "[error]",
  sessionEnded: "[session closed]",
};

export const projectTerminalPt: ProjectTerminalDict = {
  disabledTitle: "Terminal desativado para este projeto",
  disabledDescription: "Ative de novo na aba Configurações.",
  connectionErrorPrefix: "[erro]",
  sessionEnded: "[sessão encerrada]",
};
