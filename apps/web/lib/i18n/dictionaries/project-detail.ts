export interface ProjectDetailDict {
  // layout.tsx
  backToProjects: string;
  projectNotFound: string;
  projectLoadError: string;
  statusDetected: string;
  statusConfiguring: string;
  statusRunning: string;
  statusStopped: string;
  statusFailed: string;

  // project-tabs.tsx
  tabSummary: string;
  tabEnvVars: string;
  tabDatabase: string;
  tabTerminal: string;
  tabLogs: string;
  tabFiles: string;
  tabCron: string;
  tabSettings: string;

  // page.tsx
  repository: string;
  urlLabel: string;
  language: string;
  framework: string;
  packageManager: string;
  startCommand: string;
  deploy: string;
  publicUrl: string;
  container: string;
  createdAt: string;
  resourceUsage: string;
  cpu: string;
  processActive: string;
  projectNotRunning: string;
  memory: string;
  memoryLimitDetail: string;
  disk: string;
  diskFreeDetail: string;
  diskSpaceUnavailable: string;
  deployHistory: string;
  noDeploysYet: string;
  loadMoreDeploys: string;
  loadingMoreDeploys: string;
  deployStatusSuccess: string;
  deployStatusFailed: string;
  deployStatusInProgress: string;
  triggeredByWebhook: string;
  triggeredByManual: string;
  noDeployLogYet: string;
  // deploy-jobs-panel.tsx
  deployJobsTitle: string;
  deployJobPhaseReceived: string;
  deployJobPhaseWaiting: string;
  deployJobPhasePaused: string;
  deployJobPhaseStarting: string;
  deployJobPhaseFetching: string;
  deployJobPhaseBuilding: string;
  deployJobPhaseStaging: string;
  deployJobPhasePromoting: string;
  deployJobPhaseSucceeded: string;
  deployJobPhaseFailed: string;
  deployJobPhaseCanceled: string;
  deployJobPhaseInterrupted: string;
  deployJobAttempt: string;
  deployJobNextCheck: string;
  deployJobCancel: string;
  deployJobResume: string;
  deployJobTriggerManual: string;
  deployJobTriggerWebhook: string;
  deployJobTriggerStaging: string;
  deployJobActionFailed: string;
  deployJobResourceCapacity: string;
  deployJobResourceShadow: string;
  deployJobResourceShadowFallback: string;
  deployAlreadyQueued: string;
  deployDeferred: string;

  // domain-card.tsx
  customDomainTitle: string;
  deployBeforeDomain: string;
  domainLabel: string;
  statusLabel: string;
  removeDomain: string;
  dnsInstructions: string;
  domainPlaceholder: string;
  attachDomain: string;
  attachFailedError: string;
  domainAliasesTitle: string;
  domainAliasPlaceholder: string;
  addDomainAlias: string;
  removeDomainAlias: string;
  domainHelpTitle: string;
  domainHelpStep1: string;
  domainHelpStep2: string;
  domainHelpStep3: string;
  domainHelpStep4: string;
  // reconcile-state.tsx
  reconcileTitle: string;
  reconcileDescription: string;
  reconcileButton: string;
  reconcileConfirm: string;
  reconcileRunning: string;
  reconcileSuccess: string;
  reconcileBlocked: string;
  reconcileFailed: string;
  unknownError: string;
  domainStatusNone: string;
  domainStatusPending: string;
  domainStatusActive: string;
  domainStatusFailed: string;
}

export const projectDetailEn: ProjectDetailDict = {
  backToProjects: "Projects",
  projectNotFound: "Project not found.",
  projectLoadError: "Couldn't load this project. The API may be unavailable or too slow right now.",
  statusDetected: "Detected",
  statusConfiguring: "Configuring",
  statusRunning: "Running",
  statusStopped: "Stopped",
  statusFailed: "Failed",

  tabSummary: "Summary",
  tabEnvVars: "Environment Variables",
  tabDatabase: "Database",
  tabTerminal: "Terminal",
  tabLogs: "Logs",
  tabFiles: "Files",
  tabCron: "Cron",
  tabSettings: "Settings",

  repository: "Repository",
  urlLabel: "URL",
  language: "Language",
  framework: "Framework",
  packageManager: "Package manager",
  startCommand: "Start command",
  deploy: "Deploy",
  publicUrl: "Public URL",
  container: "Container",
  createdAt: "Created at",
  resourceUsage: "Resource usage",
  cpu: "CPU",
  processActive: "process active",
  projectNotRunning: "project isn't running",
  memory: "Memory",
  memoryLimitDetail: "limit of {limit} MB for this server size",
  disk: "Disk",
  diskFreeDetail: "{free} GB free on the server",
  diskSpaceUnavailable: "free space unavailable",
  deployHistory: "Deploy history",
  noDeploysYet: "No deploys recorded yet.",
  loadMoreDeploys: "Load more",
  loadingMoreDeploys: "Loading...",
  deployStatusSuccess: "Success",
  deployStatusFailed: "Failed",
  deployStatusInProgress: "In progress",
  triggeredByWebhook: "automatic push",
  triggeredByManual: "manual",
  deployJobsTitle: "Deploy queue",
  deployJobPhaseReceived: "Request received",
  deployJobPhaseWaiting: "Waiting for VPS resources",
  deployJobPhasePaused: "Paused after restart — needs resume",
  deployJobPhaseStarting: "Starting",
  deployJobPhaseFetching: "Fetching repository",
  deployJobPhaseBuilding: "Build started",
  deployJobPhaseStaging: "Validating staging",
  deployJobPhasePromoting: "Promoting to production",
  deployJobPhaseSucceeded: "Deploy completed",
  deployJobPhaseFailed: "Deploy failed",
  deployJobPhaseCanceled: "Request canceled",
  deployJobPhaseInterrupted: "Interrupted by restart",
  deployJobAttempt: "attempt {attempt}/{max}",
  deployJobNextCheck: "next check at {time}",
  deployJobCancel: "Cancel request",
  deployJobResume: "Resume",
  deployJobTriggerManual: "manual",
  deployJobTriggerWebhook: "automatic push",
  deployJobTriggerStaging: "staging only",
  deployJobActionFailed: "Couldn't perform the action. Try again.",
  deployJobResourceCapacity: "VPS: {available} MB free · deploy needs {required} MB",
  deployJobResourceShadow:
    "SIMULATION (does not decide the deploy): {samples} samples every {interval}s, confidence {confidence} — not a guarantee. Suggests {required} MB and would save {saved} MB.",
  deployJobResourceShadowFallback: "SIMULATION unavailable: {reason}. Conservative policy kept.",
  deployAlreadyQueued: "A deploy for this project is already queued or running — follow it above.",
  deployDeferred: "Worker is in maintenance; the deploy was queued and will start automatically.",
  noDeployLogYet: "No log yet.",

  customDomainTitle: "Custom domain",
  deployBeforeDomain: "Deploy the project before attaching a domain.",
  domainLabel: "Domain",
  statusLabel: "Status",
  removeDomain: "Remove domain",
  dnsInstructions:
    "Point the domain's DNS to this VPS's IP before attaching. The TLS certificate is only issued once the domain already resolves here.",
  domainPlaceholder: "myapp.com",
  attachDomain: "Attach",
  attachFailedError: "Failed to attach domain.",
  domainAliasesTitle: "Extra domains (e.g. www)",
  domainAliasPlaceholder: "www.myapp.com",
  addDomainAlias: "Add",
  removeDomainAlias: "Remove domain",
  domainHelpTitle: "How to link a domain",
  domainHelpStep1: "Buy/own a domain at any registrar (Registro.br, GoDaddy, Cloudflare, etc).",
  domainHelpStep2: "In the registrar's DNS settings, create an A record pointing to this VPS's IP:",
  domainHelpStep3: "Wait a few minutes for DNS propagation (can take up to a few hours).",
  domainHelpStep4: "Paste the domain in the field on the left and click Attach. Korrelo issues the TLS certificate automatically once DNS resolves here.",
  unknownError: "Unknown error",
  domainStatusNone: "-",
  domainStatusPending: "Issuing certificate...",
  domainStatusActive: "HTTPS active",
  domainStatusFailed: "Failed",
  reconcileTitle: "Recovery pending",
  reconcileDescription:
    "The last deploy left production, compose and database in an unconfirmed state. Reconciliation inspects the real container and its readiness; it does not deploy, restart or roll back.",
  reconcileButton: "Reconcile state",
  reconcileConfirm:
    "Reconcile the project state? Korrelo will verify the container image and readiness. If anything cannot be proven, the block remains.",
  reconcileRunning: "Reconciling...",
  reconcileSuccess: "State reconciled. New deploys are allowed again.",
  reconcileBlocked:
    "Reconciliation refused: the container image or readiness could not be confirmed. The project remains blocked.",
  reconcileFailed: "Couldn't reconcile the project state.",
};

export const projectDetailPt: ProjectDetailDict = {
  backToProjects: "Projetos",
  projectNotFound: "Projeto não encontrado.",
  projectLoadError: "Não foi possível carregar este projeto. A API pode estar indisponível ou lenta demais agora.",
  statusDetected: "Detectado",
  statusConfiguring: "Configurando",
  statusRunning: "Rodando",
  statusStopped: "Parado",
  statusFailed: "Falhou",

  tabSummary: "Resumo",
  tabEnvVars: "Variáveis de Ambiente",
  tabDatabase: "Banco de Dados",
  tabTerminal: "Terminal",
  tabLogs: "Logs",
  tabFiles: "Arquivos",
  tabCron: "Cron",
  tabSettings: "Configurações",

  repository: "Repositório",
  urlLabel: "URL",
  language: "Linguagem",
  framework: "Framework",
  packageManager: "Gerenciador de pacotes",
  startCommand: "Comando de start",
  deploy: "Deploy",
  publicUrl: "URL pública",
  container: "Container",
  createdAt: "Criado em",
  resourceUsage: "Consumo de recursos",
  cpu: "CPU",
  processActive: "processo ativo",
  projectNotRunning: "projeto não está rodando",
  memory: "Memória",
  memoryLimitDetail: "limite de {limit} MB nesse porte de servidor",
  disk: "Disco",
  diskFreeDetail: "{free} GB livres no servidor",
  diskSpaceUnavailable: "espaço livre indisponível",
  deployHistory: "Histórico de deploys",
  noDeploysYet: "Nenhum deploy registrado ainda.",
  loadMoreDeploys: "Carregar mais",
  loadingMoreDeploys: "Carregando...",
  deployStatusSuccess: "Sucesso",
  deployStatusFailed: "Falhou",
  deployStatusInProgress: "Em andamento",
  triggeredByWebhook: "push automático",
  triggeredByManual: "manual",
  deployJobsTitle: "Fila de deploy",
  deployJobPhaseReceived: "Solicitação recebida",
  deployJobPhaseWaiting: "Aguardando recursos da VPS",
  deployJobPhasePaused: "Pausado após reinício — precisa retomar",
  deployJobPhaseStarting: "Iniciando",
  deployJobPhaseFetching: "Buscando repositório",
  deployJobPhaseBuilding: "Build iniciado",
  deployJobPhaseStaging: "Validando staging",
  deployJobPhasePromoting: "Promovendo para produção",
  deployJobPhaseSucceeded: "Deploy concluído",
  deployJobPhaseFailed: "Deploy falhou",
  deployJobPhaseCanceled: "Solicitação cancelada",
  deployJobPhaseInterrupted: "Interrompido por reinício",
  deployJobAttempt: "tentativa {attempt}/{max}",
  deployJobNextCheck: "próxima verificação às {time}",
  deployJobCancel: "Cancelar solicitação",
  deployJobResume: "Retomar",
  deployJobTriggerManual: "manual",
  deployJobTriggerWebhook: "push automático",
  deployJobTriggerStaging: "somente staging",
  deployJobActionFailed: "Não foi possível concluir a ação. Tente de novo.",
  deployJobResourceCapacity: "VPS: {available} MB livres · deploy precisa de {required} MB",
  deployJobResourceShadow:
    "SIMULAÇÃO (não decide o deploy): {samples} amostras a cada {interval}s, confiança {confidence} — não é garantia. Sugere {required} MB e economizaria {saved} MB.",
  deployJobResourceShadowFallback: "SIMULAÇÃO indisponível: {reason}. Política conservadora mantida.",
  deployAlreadyQueued: "Já existe um deploy deste projeto na fila ou em execução — acompanhe acima.",
  deployDeferred: "Worker em manutenção; o deploy foi enfileirado e começa sozinho.",
  noDeployLogYet: "Nenhum log ainda.",

  customDomainTitle: "Domínio personalizado",
  deployBeforeDomain: "Faça o deploy do projeto antes de anexar um domínio.",
  domainLabel: "Domínio",
  statusLabel: "Status",
  removeDomain: "Remover domínio",
  dnsInstructions:
    "Aponte o DNS do domínio pro IP desta VPS antes de anexar. O certificado TLS só é emitido se o domínio já resolver pra cá.",
  domainPlaceholder: "meuapp.com",
  attachDomain: "Anexar",
  attachFailedError: "Falha ao anexar domínio.",
  domainAliasesTitle: "Domínios extras (ex.: www)",
  domainAliasPlaceholder: "www.meuapp.com",
  addDomainAlias: "Adicionar",
  removeDomainAlias: "Remover domínio",
  domainHelpTitle: "Como vincular um domínio",
  domainHelpStep1: "Compre/tenha um domínio em qualquer registrador (Registro.br, GoDaddy, Cloudflare, etc).",
  domainHelpStep2: "Nas configurações de DNS do registrador, crie um registro do tipo A apontando pro IP desta VPS:",
  domainHelpStep3: "Espera alguns minutos pra propagar (pode levar até algumas horas).",
  domainHelpStep4: "Cola o domínio no campo ao lado e clica em Anexar. O Korrelo emite o certificado TLS sozinho assim que o DNS resolver pra cá.",
  unknownError: "Erro desconhecido",
  domainStatusNone: "-",
  domainStatusPending: "Emitindo certificado...",
  domainStatusActive: "HTTPS ativo",
  domainStatusFailed: "Falhou",
  reconcileTitle: "Recuperação pendente",
  reconcileDescription:
    "O último deploy deixou produção, compose e banco sem confirmação. A reconciliação inspeciona o container real e o readiness; não faz deploy, restart nem rollback.",
  reconcileButton: "Reconciliar estado",
  reconcileConfirm:
    "Reconciliar o estado do projeto? O Korrelo vai verificar a imagem do container e o readiness. Se algo não puder ser comprovado, o bloqueio permanece.",
  reconcileRunning: "Reconciliando...",
  reconcileSuccess: "Estado reconciliado. Novos deploys estão liberados.",
  reconcileBlocked:
    "Reconciliação recusada: a imagem ou o readiness não puderam ser confirmados. O projeto continua bloqueado.",
  reconcileFailed: "Não foi possível reconciliar o estado do projeto.",
};
