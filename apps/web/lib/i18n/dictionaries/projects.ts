export interface ProjectsDict {
  title: string;
  subtitle: string;
  importButton: string;
  port: string;
  terminal: string;
  deployFailedLabel: string;
  statusDetected: string;
  statusConfiguring: string;
  statusRunning: string;
  statusStopped: string;
  statusFailed: string;
  projectSingular: string;
  projectPlural: string;
  runningLabel: string;
  failedLabel: string;
  sectionRunning: string;
  sectionPendingDeploy: string;
  sectionFailed: string;
  emptyState: string;
  remove: string;
  deleteConfirmBody: string;
  cancel: string;
  deployAction: string;
  deploying: string;
  deployError: string;
  unknownError: string;
  fetchReposError: string;
  createProjectError: string;
  importDetectError: string;
  fetchingRepos: string;
  noReposAvailable: string;
  deleteConfirmBodyWithDatabase: string;
  exportDatabaseButton: string;
  exportDatabaseDescription: string;
  exportDatabaseStartError: string;
  exportDatabaseFailedLabel: string;
  exportDatabaseDoneLabel: string;
  exportDatabaseDownloadButton: string;
  deleteAnywayCheckbox: string;
}

export const projectsEn: ProjectsDict = {
  title: "Projects",
  subtitle: "Import from GitHub and deploy with one click.",
  importButton: "Import from GitHub",
  port: "port",
  terminal: "Terminal",
  deployFailedLabel: "Deploy failed.",
  statusDetected: "Detected",
  statusConfiguring: "Configuring",
  statusRunning: "Running",
  statusStopped: "Stopped",
  statusFailed: "Failed",
  projectSingular: "project",
  projectPlural: "projects",
  runningLabel: "running",
  failedLabel: "failed",
  sectionRunning: "Running",
  sectionPendingDeploy: "Waiting to deploy",
  sectionFailed: "Failed",
  emptyState: "No projects yet. Import a repository from GitHub to get started.",
  remove: "Remove",
  deleteConfirmBody: "This stops the container (if running) and deletes the cloned files. This can't be undone.",
  cancel: "Cancel",
  deployAction: "Deploy",
  deploying: "Deploying...",
  deployError: "Failed to deploy.",
  unknownError: "Unknown error",
  fetchReposError: "Couldn't fetch repositories.",
  createProjectError: "Failed to create the project.",
  importDetectError: "Failed to import/detect the stack.",
  fetchingRepos: "Fetching repositories...",
  noReposAvailable: "No repositories available.",
  deleteConfirmBodyWithDatabase:
    "This stops the container, deletes the cloned files AND the project's database volume (data included). This can't be undone.",
  exportDatabaseButton: "Export database first",
  exportDatabaseDescription: "Generates a downloadable dump of this project's database before you delete anything.",
  exportDatabaseStartError: "Failed to start the export.",
  exportDatabaseFailedLabel: "Export failed",
  exportDatabaseDoneLabel: "Export ready",
  exportDatabaseDownloadButton: "Download",
  deleteAnywayCheckbox: "I don't need the data, delete anyway",
};

export const projectsPt: ProjectsDict = {
  title: "Projetos",
  subtitle: "Importe do GitHub e implante com um clique.",
  importButton: "Importar do GitHub",
  port: "porta",
  terminal: "Terminal",
  deployFailedLabel: "O deploy falhou.",
  statusDetected: "Detectado",
  statusConfiguring: "Configurando",
  statusRunning: "Rodando",
  statusStopped: "Parado",
  statusFailed: "Falhou",
  projectSingular: "projeto",
  projectPlural: "projetos",
  runningLabel: "rodando",
  failedLabel: "falhou",
  sectionRunning: "Rodando",
  sectionPendingDeploy: "Aguardando deploy",
  sectionFailed: "Falharam",
  emptyState: "Nenhum projeto ainda. Importe um repositório do GitHub pra começar.",
  remove: "Remover",
  deleteConfirmBody: "Isso para o container (se estiver rodando) e apaga os arquivos clonados. Não pode ser desfeito.",
  cancel: "Cancelar",
  deployAction: "Deploy",
  deploying: "Fazendo deploy...",
  deployError: "Falha ao fazer deploy.",
  unknownError: "Erro desconhecido",
  fetchReposError: "Não foi possível buscar os repositórios.",
  createProjectError: "Falha ao criar o projeto.",
  importDetectError: "Falha ao importar/detectar a stack.",
  fetchingRepos: "Buscando repositórios...",
  noReposAvailable: "Nenhum repositório disponível.",
  deleteConfirmBodyWithDatabase:
    "Isso para o container, apaga os arquivos clonados E o volume do banco de dados do projeto (dados inclusos). Não pode ser desfeito.",
  exportDatabaseButton: "Exportar banco antes",
  exportDatabaseDescription: "Gera um arquivo pra baixar com o banco de dados deste projeto antes de apagar qualquer coisa.",
  exportDatabaseStartError: "Falha ao iniciar a exportação.",
  exportDatabaseFailedLabel: "Exportação falhou",
  exportDatabaseDoneLabel: "Exportação pronta",
  exportDatabaseDownloadButton: "Baixar",
  deleteAnywayCheckbox: "Não preciso dos dados, apagar mesmo assim",
};
