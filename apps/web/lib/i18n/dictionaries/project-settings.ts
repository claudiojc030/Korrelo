export interface ProjectSettingsDict {
  loadError: string;
  featuresTitle: string;
  featuresSubtitle: string;
  databaseTitle: string;
  databaseDescription: string;
  terminalTitle: string;
  terminalDescription: string;
  autoDeployTitle: string;
  webhookDescriptionPrefix: string;
  webhookDescriptionSuffix: string;
  pushDeployTitle: string;
  pushDeployDescription: string;
  branchTitle: string;
  branchDescription: string;
  branchPlaceholder: string;
  diskAlertTitle: string;
  diskAlertDescription: string;
  diskAlertLabel: string;
  diskAlertHint: string;
  diskAlertPlaceholder: string;
  deployStrategyTitle: string;
  deployStrategySubtitle: string;
  skipStagingTitle: string;
  skipStagingDescription: string;
  memoryLimitTitle: string;
  memoryLimitDescription: string;
  memoryLimitLabel: string;
  memoryLimitHint: string;
  memoryLimitPlaceholder: string;
  stagingMemoryTitle: string;
  stagingMemoryDescription: string;
  stagingMemoryLabel: string;
  stagingMemoryHint: string;
  stagingMemoryPlaceholder: string;
  stagingTimeoutTitle: string;
  stagingTimeoutDescription: string;
  stagingTimeoutLabel: string;
  stagingTimeoutHint: string;
  stagingTimeoutPlaceholder: string;
  healthcheckTitle: string;
  healthcheckDescription: string;
  healthcheckEnabledLabel: string;
  healthcheckEnabledHint: string;
  healthcheckPathLabel: string;
  healthcheckPathHint: string;
  healthcheckPathPlaceholder: string;
}

export const projectSettingsEn: ProjectSettingsDict = {
  loadError: "Couldn't load the settings.",
  featuresTitle: "Features for this project",
  featuresSubtitle: "Not every project needs everything. Turn off what you won't use and the matching tab disappears from the navigation.",
  databaseTitle: "Database",
  databaseDescription: "Provision or connect a database for this project.",
  terminalTitle: "Terminal",
  terminalDescription: "Access a terminal for this project's container right from the browser.",
  autoDeployTitle: "Automatic deploy",
  webhookDescriptionPrefix: 'Requires the GitHub App Webhook configured with the "Push" event pointing to',
  webhookDescriptionSuffix: "on this VPS (only once, in the App's settings on github.com).",
  pushDeployTitle: "Deploy on push",
  pushDeployDescription: "Deploys automatically whenever a push lands on the branch below, no clicking needed.",
  branchTitle: "Watched branch",
  branchDescription: "Only pushes to this branch trigger a deploy.",
  branchPlaceholder: "main",
  diskAlertTitle: "Disk usage alert",
  diskAlertDescription:
    "Korrelo doesn't hard-cap disk per project (Docker's default storage driver can't enforce a per-container quota without repartitioning the whole VPS), but it can warn you. Requires BACKUP_ALERT_NTFY_TOPIC configured (Settings, or during setup).",
  diskAlertLabel: "Alert threshold",
  diskAlertHint: "Leave empty to disable. Checked hourly, re-notifies at most once a day.",
  diskAlertPlaceholder: "5",
  deployStrategyTitle: "Deploy strategy",
  deployStrategySubtitle: "How a new deploy replaces the running version.",
  skipStagingTitle: "Deploy directly, skip the test container",
  skipStagingDescription:
    "By default, deploy builds a test instance first and only swaps production if it responds. Turn this on for apps that hold an exclusive stateful connection (e.g. a WhatsApp gateway) - the test instance would otherwise run alongside production and fight over the same session. Without the test step, a broken build only shows up after production is already replaced.",
  memoryLimitTitle: "Memory limit",
  memoryLimitDescription:
    "By default, Korrelo splits the VPS's available RAM evenly across every running project. Set a fixed limit here to take a project out of that automatic split and control it yourself.",
  memoryLimitLabel: "Fixed limit",
  memoryLimitHint: "Leave empty to go back to the automatic split. Applies on the next deploy.",
  memoryLimitPlaceholder: "512",
  stagingMemoryTitle: "Test container memory",
  stagingMemoryDescription:
    "The test container (staging) gets a share of the VPS's RAM by default. Set a value here when your app needs more room to boot than the automatic split gives it - a slow first start on a single-vCPU VPS usually means the test container ran out of memory. This only affects the test container: production, the database and the other projects keep their own limits.",
  stagingMemoryLabel: "Test container limit",
  stagingMemoryHint:
    "Leave empty to go back to the automatic split. Can't be higher than the production limit, and never below 128 MB. Applies on the next deploy.",
  stagingMemoryPlaceholder: "600",
  stagingTimeoutTitle: "Test container health timeout",
  stagingTimeoutDescription:
    "How long Korrelo waits for the test container to answer before giving up on the deploy (the production version is not touched). Raise it for apps that take a while to boot on a small VPS - the default is 30 seconds.",
  stagingTimeoutLabel: "Wait time",
  stagingTimeoutHint:
    "Leave empty to use the default (30s). Between 10 and 300 seconds. Applies on the next deploy.",
  stagingTimeoutPlaceholder: "120",
  healthcheckTitle: "Container healthcheck",
  healthcheckDescription:
    "Optional. When enabled, Docker checks this path on the container and restarts it only after several consecutive failures (with a generous start period, so a slow app isn't killed while booting).",
  healthcheckEnabledLabel: "Enable healthcheck",
  healthcheckEnabledHint: "Off by default: a wrong probe would restart a healthy app.",
  healthcheckPathLabel: "Health path",
  healthcheckPathHint: "Path checked inside the container (must answer with a status below 500).",
  healthcheckPathPlaceholder: "/",
};

export const projectSettingsPt: ProjectSettingsDict = {
  loadError: "Não foi possível carregar as configurações.",
  featuresTitle: "Funcionalidades deste projeto",
  featuresSubtitle: "Nem todo projeto precisa de tudo. Desative o que não for usar e a aba correspondente some da navegação.",
  databaseTitle: "Banco de Dados",
  databaseDescription: "Provisionar ou conectar um banco de dados pra este projeto.",
  terminalTitle: "Terminal",
  terminalDescription: "Acesso a um terminal do container deste projeto direto pelo navegador.",
  autoDeployTitle: "Deploy automático",
  webhookDescriptionPrefix: 'Exige o Webhook do GitHub App configurado com o evento "Push" apontando pra',
  webhookDescriptionSuffix: "nesta VPS (uma vez só, nas settings do App no github.com).",
  pushDeployTitle: "Deploy ao dar push",
  pushDeployDescription: "Faz o deploy sozinho sempre que chega um push na branch abaixo, sem precisar clicar em nada.",
  branchTitle: "Branch monitorada",
  branchDescription: "Só pushes pra essa branch disparam o deploy.",
  branchPlaceholder: "main",
  diskAlertTitle: "Alerta de uso de disco",
  diskAlertDescription:
    "O Korrelo não trava o disco por projeto (o driver de storage padrão do Docker não segura quota por container sem reparticionar a VPS inteira), mas pode te avisar. Exige BACKUP_ALERT_NTFY_TOPIC configurado (aba Configurações, ou na instalação).",
  diskAlertLabel: "Limite pro alerta",
  diskAlertHint: "Deixe vazio pra desativar. Checado de hora em hora, reavisa no máximo uma vez por dia.",
  diskAlertPlaceholder: "5",
  deployStrategyTitle: "Estratégia de deploy",
  deployStrategySubtitle: "Como um novo deploy troca a versão que tá rodando.",
  skipStagingTitle: "Deploy direto, sem container de teste",
  skipStagingDescription:
    "Por padrão, o deploy builda uma instância de teste primeiro e só troca a produção se ela responder. Ative isso pra apps que seguram uma conexão exclusiva com estado (ex.: gateway de WhatsApp) - senão a instância de teste roda junto com a produção e disputa a mesma sessão. Sem a etapa de teste, um build quebrado só aparece depois que a produção já foi trocada.",
  memoryLimitTitle: "Limite de memória",
  memoryLimitDescription:
    "Por padrão, o Korrelo divide a RAM disponível da VPS igualmente entre todo projeto rodando. Defina um limite fixo aqui pra tirar um projeto desse rateio automático e controlar você mesmo.",
  memoryLimitLabel: "Limite fixo",
  memoryLimitHint: "Deixe vazio pra voltar ao rateio automático. Vale a partir do próximo deploy.",
  memoryLimitPlaceholder: "512",
  stagingMemoryTitle: "Memória do container de teste",
  stagingMemoryDescription:
    "Por padrão, o container de teste (staging) recebe uma fatia da RAM da VPS. Defina um valor aqui quando seu app precisa de mais espaço pra subir do que o rateio automático dá - um boot lento numa VPS de 1 vCPU quase sempre significa que o container de teste ficou sem memória. Isso afeta só o container de teste: a produção, o banco e os outros projetos mantêm seus limites.",
  stagingMemoryLabel: "Limite do container de teste",
  stagingMemoryHint:
    "Deixe vazio pra voltar ao rateio automático. Não pode passar do limite de produção, nem ficar abaixo de 128 MB. Vale a partir do próximo deploy.",
  stagingMemoryPlaceholder: "600",
  stagingTimeoutTitle: "Timeout de health do container de teste",
  stagingTimeoutDescription:
    "Quanto tempo o Korrelo espera o container de teste responder antes de desistir do deploy (a versão em produção não é tocada). Aumente para apps que demoram pra subir numa VPS pequena - o padrão é 30 segundos.",
  stagingTimeoutLabel: "Tempo de espera",
  stagingTimeoutHint:
    "Deixe vazio pra usar o padrão (30s). Entre 10 e 300 segundos. Vale a partir do próximo deploy.",
  stagingTimeoutPlaceholder: "120",
  healthcheckTitle: "Healthcheck do container",
  healthcheckDescription:
    "Opcional. Quando ligado, o Docker checa esse caminho dentro do container e só reinicia a aplicação depois de várias falhas seguidas (com um período de tolerância generoso, pra não matar um app que só demora pra subir).",
  healthcheckEnabledLabel: "Ativar healthcheck",
  healthcheckEnabledHint: "Desligado por padrão: um probe errado reiniciaria um app saudável.",
  healthcheckPathLabel: "Caminho de saúde",
  healthcheckPathHint: "Caminho checado dentro do container (precisa responder com status abaixo de 500).",
  healthcheckPathPlaceholder: "/",
};
