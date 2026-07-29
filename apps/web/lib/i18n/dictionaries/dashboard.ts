export interface DashboardDict {
  title: string;
  autoRefreshNote: string;
  metricsUnavailable: string;
  overview: string;
  overviewSubtitle: string;
  cpu: string;
  cpuDetail: string;
  memory: string;
  disk: string;
  memoryOf: string;
  uptime: string;
  runningProjects: string;
  runningProjectsSubtitle: string;
  noRunningProjects: string;
  terminal: string;
  infrastructure: string;
  infrastructureSubtitle: string;
  noInfraContainers: string;
  tierLabel: string;
  tierNano: string;
  tierMicro: string;
  tierSmall: string;
  tierMedium: string;
  tierLarge: string;
  tierPopoverIntro: string;
  tierColTier: string;
  tierColRam: string;
  tierColLimit: string;
  tierYou: string;
  tierRamUpTo1: string;
  tierRamUpTo4: string;
  tierRamUpTo8: string;
  tierRamUpTo16: string;
  tierRamAbove16: string;
  onboardingTitle: string;
  onboardingGithubLabel: string;
  onboardingGithubDescription: string;
  onboardingProjectLabel: string;
  onboardingProjectDescription: string;
  onboardingProjectAction: string;
  onboarding2faLabel: string;
  onboarding2faDescription: string;
  onboarding2faAction: string;
  updateAvailable: string;
  commitsBehindSingular: string;
  commitsBehindPlural: string;
  showCommand: string;
  hideCommand: string;
  runViaSsh: string;
  copyCommand: string;
  copied: string;
  historyTitle: string;
  historySubtitle: string;
  historyError: string;
  historyLoading: string;
  historyNotEnoughData: string;
}

export const dashboardEn: DashboardDict = {
  title: "Dashboard",
  autoRefreshNote: "Refreshes every 12s",
  metricsUnavailable: "Couldn't load metrics. Check whether the API is running.",
  overview: "Overview",
  overviewSubtitle: "server total",
  cpu: "CPU",
  cpuDetail: "average usage now",
  memory: "Memory",
  disk: "Disk",
  memoryOf: "of",
  uptime: "Uptime",
  runningProjects: "Running projects",
  runningProjectsSubtitle: "individual usage",
  noRunningProjects: "No project running right now.",
  terminal: "Terminal",
  infrastructure: "Infrastructure",
  infrastructureSubtitle: "support containers",
  noInfraContainers: "No infrastructure container active.",
  tierLabel: "Size",
  tierNano: "Nano",
  tierMicro: "Micro",
  tierSmall: "Small",
  tierMedium: "Medium",
  tierLarge: "Large",
  tierPopoverIntro: "Size is based on the VPS's total RAM, which sets the memory limit per deployed project container.",
  tierColTier: "Size",
  tierColRam: "VPS RAM",
  tierColLimit: "Limit / container",
  tierYou: "(you)",
  tierRamUpTo1: "up to 1 GB",
  tierRamUpTo4: "up to 4 GB",
  tierRamUpTo8: "up to 8 GB",
  tierRamUpTo16: "up to 16 GB",
  tierRamAbove16: "above 16 GB",
  onboardingTitle: "First steps",
  onboardingGithubLabel: "Connect your GitHub account",
  onboardingGithubDescription: "Needed to import and deploy your repositories.",
  onboardingProjectLabel: "Create or import your first project",
  onboardingProjectDescription: "Bring an existing repository or start a new one.",
  onboardingProjectAction: "Go to Projects",
  onboarding2faLabel: "Turn on two-factor authentication",
  onboarding2faDescription: "Protects your admin account with a second factor.",
  onboarding2faAction: "Go to Security",
  updateAvailable: "Update available",
  commitsBehindSingular: "commit behind the repository",
  commitsBehindPlural: "commits behind the repository",
  showCommand: "Show command",
  hideCommand: "Hide command",
  runViaSsh: "Run this via SSH, at the repository root on your VPS:",
  copyCommand: "Copy command",
  copied: "Copied",
  historyTitle: "History",
  historySubtitle: "CPU, memory and disk",
  historyError: "Couldn't load the history.",
  historyLoading: "Loading...",
  historyNotEnoughData: "Not enough data yet for this period. Collection runs every minute.",
};

export const dashboardPt: DashboardDict = {
  title: "Dashboard",
  autoRefreshNote: "Atualiza a cada 12s",
  metricsUnavailable: "Não foi possível carregar as métricas. Verifique se a API está no ar.",
  overview: "Geral",
  overviewSubtitle: "total do servidor",
  cpu: "CPU",
  cpuDetail: "uso médio agora",
  memory: "Memória",
  disk: "Disco",
  memoryOf: "de",
  uptime: "Uptime",
  runningProjects: "Projetos rodando",
  runningProjectsSubtitle: "consumo individual",
  noRunningProjects: "Nenhum projeto rodando no momento.",
  terminal: "Terminal",
  infrastructure: "Infraestrutura",
  infrastructureSubtitle: "containers de suporte",
  noInfraContainers: "Nenhum container de infraestrutura ativo.",
  tierLabel: "Porte",
  tierNano: "Nano",
  tierMicro: "Micro",
  tierSmall: "Pequeno",
  tierMedium: "Médio",
  tierLarge: "Grande",
  tierPopoverIntro: "Porte classificado pela RAM total da VPS, que define o limite de memória por container de projeto implantado.",
  tierColTier: "Porte",
  tierColRam: "RAM da VPS",
  tierColLimit: "Limite / container",
  tierYou: "(você)",
  tierRamUpTo1: "até 1 GB",
  tierRamUpTo4: "até 4 GB",
  tierRamUpTo8: "até 8 GB",
  tierRamUpTo16: "até 16 GB",
  tierRamAbove16: "acima de 16 GB",
  onboardingTitle: "Primeiros passos",
  onboardingGithubLabel: "Conectar sua conta do GitHub",
  onboardingGithubDescription: "Necessário pra importar e implantar seus repositórios.",
  onboardingProjectLabel: "Criar ou importar seu primeiro projeto",
  onboardingProjectDescription: "Traga um repositório existente ou comece um novo.",
  onboardingProjectAction: "Ir pra Projetos",
  onboarding2faLabel: "Ativar autenticação em duas etapas",
  onboarding2faDescription: "Protege sua conta de administrador com um segundo fator.",
  onboarding2faAction: "Ir pra Segurança",
  updateAvailable: "Atualização disponível",
  commitsBehindSingular: "commit atrás do repositório",
  commitsBehindPlural: "commits atrás do repositório",
  showCommand: "Ver comando",
  hideCommand: "Ocultar comando",
  runViaSsh: "Rode isso via SSH, na raiz do repositório na sua VPS:",
  copyCommand: "Copiar comando",
  copied: "Copiado",
  historyTitle: "Histórico",
  historySubtitle: "CPU, memória e disco",
  historyError: "Não foi possível carregar o histórico.",
  historyLoading: "Carregando...",
  historyNotEnoughData: "Ainda não há dados suficientes pra esse período. A coleta roda a cada minuto.",
};
