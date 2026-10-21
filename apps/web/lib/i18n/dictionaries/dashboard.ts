export interface DashboardDict {
  title: string;
  autoRefreshNote: string;
  metricsUnavailable: string;
  metricsStale: string;
  dockerUnreachable: string;
  projectsUnavailable: string;
  overview: string;
  overviewSubtitle: string;
  cpu: string;
  cpuDetail: string;
  /** Mostrado quando ainda não há medição válida de CPU. */
  cpuCollecting: string;
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
  updateNowButton: string;
  updateAlreadyRunning: string;
  updateStartFailed: string;
  updateRestartingTitle: string;
  updateRestartingSubtitle: string;
  updateDoneTitle: string;
  updateDoneSubtitle: string;
  updateFailedTitle: string;
  updateLogLabel: string;
  updateCloseButton: string;
  /** Wave 3: o update roda desacoplado - a API pode reiniciar no meio. */
  updateReconnectingTitle: string;
  updateReconnectingSubtitle: string;
  updateInterruptedTitle: string;
  updateInterruptedSubtitle: string;
  updateProductionIntact: string;
  updateStageLabel: string;
  updatePreviousVersion: string;
  updateCandidateVersion: string;
  /** Observabilidade do self-update (estado, etapa, tempo e atividade). */
  updateStateLabel: string;
  updateStateRunning: string;
  updateStateWaiting: string;
  updateStateSuccess: string;
  updateStateFailed: string;
  updateWaitingTitle: string;
  updateWaitingSubtitle: string;
  updateWaitingNextRetry: string;
  updateElapsedLabel: string;
  updateActivityTitle: string;
  updateActivityEmpty: string;
  updateReloadDashboard: string;
  updateFailedStageLabel: string;
  updateDurationLabel: string;
  /** Nomes amigáveis das etapas do rollout. */
  updateStages: Record<string, string>;
}

export const dashboardEn: DashboardDict = {
  title: "Dashboard",
  autoRefreshNote: "Refreshes every 30s",
  metricsUnavailable: "Couldn't load metrics. Check whether the API is running.",
  metricsStale: "These values may be outdated: the last collection didn't complete.",
  dockerUnreachable: "The Docker daemon didn't answer, so the container list may be outdated.",
  projectsUnavailable: "Couldn't load the project list. Check whether the API is running.",
  overview: "Overview",
  overviewSubtitle: "server total",
  cpu: "CPU",
  cpuDetail: "average usage now",
  cpuCollecting: "Collecting...",
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
  updateNowButton: "Update now",
  updateAlreadyRunning: "An update is already running.",
  updateStartFailed: "Couldn't start the update.",
  updateRestartingTitle: "Restarting the server...",
  updateRestartingSubtitle: "This can take a few seconds. The page will reload automatically.",
  updateDoneTitle: "Update completed successfully",
  updateDoneSubtitle: "Reloading the page...",
  updateFailedTitle: "Update failed",
  updateLogLabel: "Process log",
  updateCloseButton: "Close",
  updateReconnectingTitle: "Korrelo is restarting...",
  updateReconnectingSubtitle: "Waiting for the API to come back. The update continues on its own.",
  updateInterruptedTitle: "Update interrupted",
  updateInterruptedSubtitle: "The update process stopped before finishing.",
  updateProductionIntact: "Your projects were not changed.",
  updateStageLabel: "Stage",
  updatePreviousVersion: "Previous version",
  updateCandidateVersion: "Updating to",
  updateStateLabel: "State",
  updateStateRunning: "RUNNING",
  updateStateWaiting: "WAITING",
  updateStateSuccess: "SUCCESS",
  updateStateFailed: "FAILED",
  updateWaitingTitle: "Waiting for VPS resources",
  updateWaitingSubtitle:
    "The update is not stuck - it's waiting for the host to free up resources before it can continue.",
  updateWaitingNextRetry: "Next check in",
  updateElapsedLabel: "Elapsed time",
  updateActivityTitle: "Recent activity",
  updateActivityEmpty: "No activity yet.",
  updateReloadDashboard: "Reload dashboard",
  updateFailedStageLabel: "Failed at",
  updateDurationLabel: "Duration",
  updateStages: {
    preflight: "Checking the update",
    lock: "Blocking concurrent updates",
    "worker-drain": "Pausing new deploys",
    "git-check": "Checking the working tree",
    "resource-preflight": "Measuring host resources",
    "snapshot-before": "Protecting project state",
    "core-backup": "Backing up the Core",
    "git-update": "Updating the code",
    "artifacts-snapshot": "Snapshotting Core artifacts",
    install: "Installing dependencies",
    "worktree-check": "Checking the install",
    "toolchain-check": "Validating the build toolchain",
    "build-shared": "Building shared packages",
    "build-api": "Building the API",
    "build-web": "Building the dashboard",
    "web-assets": "Copying web assets",
    migration: "Applying Core migrations",
    permissions: "Fixing Core file permissions",
    "pm2-restart": "Restarting Korrelo",
    "health-core": "Checking health",
    "snapshot-after": "Verifying the projects",
    "compare-projects": "Confirming the projects didn't change",
    "git-verify": "Verifying the final commit",
    "worker-release": "Releasing the deploy worker",
    complete: "Done",
  },
};

export const dashboardPt: DashboardDict = {
  title: "Dashboard",
  autoRefreshNote: "Atualiza a cada 30s",
  metricsUnavailable: "Não foi possível carregar as métricas. Verifique se a API está no ar.",
  metricsStale: "Estes valores podem estar desatualizados: a última coleta não foi concluída.",
  dockerUnreachable: "O Docker não respondeu, então a lista de containers pode estar desatualizada.",
  projectsUnavailable: "Não foi possível carregar a lista de projetos. Verifique se a API está no ar.",
  overview: "Geral",
  overviewSubtitle: "total do servidor",
  cpu: "CPU",
  cpuDetail: "uso médio agora",
  cpuCollecting: "Coletando...",
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
  updateNowButton: "Atualizar agora",
  updateAlreadyRunning: "Uma atualização já está em andamento.",
  updateStartFailed: "Não foi possível iniciar a atualização.",
  updateRestartingTitle: "Reiniciando o servidor...",
  updateRestartingSubtitle: "Isso pode levar alguns segundos. A página vai recarregar sozinha.",
  updateDoneTitle: "Atualização concluída com sucesso",
  updateDoneSubtitle: "Recarregando a página...",
  updateFailedTitle: "Falha na atualização",
  updateLogLabel: "Log do processo",
  updateCloseButton: "Fechar",
  updateReconnectingTitle: "O Korrelo está reiniciando...",
  updateReconnectingSubtitle:
    "Esperando a API voltar. A atualização continua sozinha - não precisa recarregar a página.",
  updateInterruptedTitle: "Atualização interrompida",
  updateInterruptedSubtitle: "O processo da atualização parou antes de terminar.",
  updateProductionIntact: "Seus projetos de produção não foram alterados.",
  updateStageLabel: "Etapa",
  updatePreviousVersion: "Versão anterior",
  updateCandidateVersion: "Atualizando para",
  updateStateLabel: "Estado",
  updateStateRunning: "EXECUTANDO",
  updateStateWaiting: "AGUARDANDO",
  updateStateSuccess: "CONCLUÍDO",
  updateStateFailed: "FALHOU",
  updateWaitingTitle: "Aguardando recursos da VPS",
  updateWaitingSubtitle:
    "A atualização não está travada - está esperando o host liberar recursos para poder continuar.",
  updateWaitingNextRetry: "Próxima checagem em",
  updateElapsedLabel: "Tempo decorrido",
  updateActivityTitle: "Atividade recente",
  updateActivityEmpty: "Nenhuma atividade ainda.",
  updateReloadDashboard: "Recarregar painel",
  updateFailedStageLabel: "Falhou em",
  updateDurationLabel: "Duração",
  updateStages: {
    preflight: "Verificando atualização",
    lock: "Bloqueando atualizações concorrentes",
    "worker-drain": "Pausando novos deploys",
    "git-check": "Conferindo o working tree",
    "resource-preflight": "Medindo os recursos do host",
    "snapshot-before": "Protegendo o estado dos projetos",
    "core-backup": "Backup do Core",
    "git-update": "Atualizando código",
    "artifacts-snapshot": "Guardando os artefatos do Core",
    install: "Instalando dependências",
    "worktree-check": "Conferindo a instalação",
    "toolchain-check": "Validando a toolchain de build",
    "build-shared": "Compilando pacotes compartilhados",
    "build-api": "Compilando API",
    "build-web": "Compilando painel",
    "web-assets": "Copiando arquivos do painel",
    migration: "Aplicando migrations do Core",
    permissions: "Ajustando permissões do Core",
    "pm2-restart": "Reiniciando Korrelo",
    "health-core": "Verificando saúde",
    "snapshot-after": "Verificando projetos",
    "compare-projects": "Confirmando que projetos não mudaram",
    "git-verify": "Verificando o commit final",
    "worker-release": "Liberando o worker de deploy",
    complete: "Concluído",
  },
};
