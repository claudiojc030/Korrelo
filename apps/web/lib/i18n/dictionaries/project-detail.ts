export interface ProjectDetailDict {
  // layout.tsx
  backToProjects: string;
  projectNotFound: string;
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
  deployStatusSuccess: string;
  deployStatusFailed: string;
  deployStatusInProgress: string;
  triggeredByWebhook: string;
  triggeredByManual: string;
  noDeployLogYet: string;

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
  unknownError: string;
  domainStatusNone: string;
  domainStatusPending: string;
  domainStatusActive: string;
  domainStatusFailed: string;
}

export const projectDetailEn: ProjectDetailDict = {
  backToProjects: "Projects",
  projectNotFound: "Project not found.",
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
  deployStatusSuccess: "Success",
  deployStatusFailed: "Failed",
  deployStatusInProgress: "In progress",
  triggeredByWebhook: "automatic push",
  triggeredByManual: "manual",
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
  unknownError: "Unknown error",
  domainStatusNone: "-",
  domainStatusPending: "Issuing certificate...",
  domainStatusActive: "HTTPS active",
  domainStatusFailed: "Failed",
};

export const projectDetailPt: ProjectDetailDict = {
  backToProjects: "Projetos",
  projectNotFound: "Projeto não encontrado.",
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
  deployStatusSuccess: "Sucesso",
  deployStatusFailed: "Falhou",
  deployStatusInProgress: "Em andamento",
  triggeredByWebhook: "push automático",
  triggeredByManual: "manual",
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
  unknownError: "Erro desconhecido",
  domainStatusNone: "-",
  domainStatusPending: "Emitindo certificado...",
  domainStatusActive: "HTTPS ativo",
  domainStatusFailed: "Falhou",
};
