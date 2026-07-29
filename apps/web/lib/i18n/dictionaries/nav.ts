export interface NavDict {
  search: string;
  dashboard: string;
  projects: string;
  systemServices: string;
  security: string;
  logout: string;
  languageSwitchTo: string;
  commandPaletteGoTo: string;
  commandPaletteEsc: string;
  commandPaletteNoResults: string;
  commandPaletteProjectSublabel: string;
  connectGithub: string;
  createGithubApp: string;
  darkTheme: string;
  lightTheme: string;
  systemTerminal: string;
  systemTerminalWarning: string;
}

export const navEn: NavDict = {
  search: "Search",
  dashboard: "Dashboard",
  projects: "Projects",
  systemServices: "Server services",
  security: "Security",
  logout: "Log out",
  languageSwitchTo: "Português",
  commandPaletteGoTo: "Go to...",
  commandPaletteEsc: "Esc",
  commandPaletteNoResults: "Nothing found.",
  commandPaletteProjectSublabel: "Project",
  connectGithub: "Connect GitHub",
  createGithubApp: "Create GitHub App automatically",
  darkTheme: "Dark theme",
  lightTheme: "Light theme",
  systemTerminal: "VPS Terminal",
  systemTerminalWarning:
    "This shell runs directly on the VPS host, not inside a project container. Anything you run here can affect the whole server.",
};

export const navPt: NavDict = {
  search: "Buscar",
  dashboard: "Dashboard",
  projects: "Projetos",
  systemServices: "Serviços do servidor",
  security: "Segurança",
  logout: "Sair",
  languageSwitchTo: "English",
  commandPaletteGoTo: "Ir pra...",
  commandPaletteEsc: "Esc",
  commandPaletteNoResults: "Nada encontrado.",
  commandPaletteProjectSublabel: "Projeto",
  connectGithub: "Conectar GitHub",
  createGithubApp: "Criar GitHub App automaticamente",
  darkTheme: "Tema escuro",
  lightTheme: "Tema claro",
  systemTerminal: "Terminal da VPS",
  systemTerminalWarning:
    "Esse shell roda direto no host da VPS, não dentro do container de um projeto. Qualquer coisa que você rodar aqui pode afetar o servidor inteiro.",
};
