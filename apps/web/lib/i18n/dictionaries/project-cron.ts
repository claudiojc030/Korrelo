export interface ProjectCronDict {
  title: string;
  subtitle: string;
  newTask: string;
  nameLabel: string;
  namePlaceholder: string;
  commandLabel: string;
  commandPlaceholder: string;
  scheduleLabel: string;
  schedulePlaceholder: string;
  scheduleExampleEvery5Min: string;
  scheduleExampleEveryHour: string;
  scheduleExampleDaily3am: string;
  scheduleExampleWeeklySunday: string;
  createButton: string;
  createError: string;
  runError: string;
  unknownError: string;
  emptyState: string;
  lastRanAtTemplate: string;
  neverRanYet: string;
  statusNeverRun: string;
  statusSuccess: string;
  statusFailed: string;
  runNow: string;
  remove: string;
  hideOutput: string;
  viewOutput: string;
  confirmDeleteTitleTemplate: string;
  cannotBeUndone: string;
}

export const projectCronEn: ProjectCronDict = {
  title: "Scheduled tasks (cron)",
  subtitle: "Each task runs the command inside this project's container, at the set time.",
  newTask: "New task",
  nameLabel: "Name",
  namePlaceholder: "Clear old cache",
  commandLabel: "Command (runs inside the container)",
  commandPlaceholder: "npm run cron:clear-cache",
  scheduleLabel: "Schedule (cron expression)",
  schedulePlaceholder: "0 3 * * *",
  scheduleExampleEvery5Min: "every 5 minutes",
  scheduleExampleEveryHour: "every hour",
  scheduleExampleDaily3am: "every day at 3am",
  scheduleExampleWeeklySunday: "every week, midnight on Sunday",
  createButton: "Create task",
  createError: "Failed to create the cron job.",
  runError: "Failed to run the cron job.",
  unknownError: "Unknown error",
  emptyState: "No task scheduled for this project yet.",
  lastRanAtTemplate: "Last run: {date}",
  neverRanYet: "Never ran yet",
  statusNeverRun: "Never ran",
  statusSuccess: "Success",
  statusFailed: "Failed",
  runNow: "Run now",
  remove: "Remove",
  hideOutput: "Hide output",
  viewOutput: "View last run output",
  confirmDeleteTitleTemplate: 'Remove "{name}"?',
  cannotBeUndone: "This can't be undone.",
};

export const projectCronPt: ProjectCronDict = {
  title: "Tarefas agendadas (cron)",
  subtitle: "Cada tarefa roda o comando dentro do container deste projeto, no horário definido.",
  newTask: "Nova tarefa",
  nameLabel: "Nome",
  namePlaceholder: "Limpar cache antigo",
  commandLabel: "Comando (roda dentro do container)",
  commandPlaceholder: "npm run cron:limpar-cache",
  scheduleLabel: "Agendamento (expressão cron)",
  schedulePlaceholder: "0 3 * * *",
  scheduleExampleEvery5Min: "a cada 5 minutos",
  scheduleExampleEveryHour: "a cada hora",
  scheduleExampleDaily3am: "todo dia às 3h",
  scheduleExampleWeeklySunday: "toda semana, domingo à meia-noite",
  createButton: "Criar tarefa",
  createError: "Falha ao criar o cron job.",
  runError: "Falha ao rodar o cron job.",
  unknownError: "Erro desconhecido",
  emptyState: "Nenhuma tarefa agendada pra este projeto ainda.",
  lastRanAtTemplate: "Última execução: {date}",
  neverRanYet: "Nunca rodou ainda",
  statusNeverRun: "Nunca rodou",
  statusSuccess: "Sucesso",
  statusFailed: "Falhou",
  runNow: "Rodar agora",
  remove: "Remover",
  hideOutput: "Ocultar saída",
  viewOutput: "Ver saída da última execução",
  confirmDeleteTitleTemplate: 'Remover "{name}"?',
  cannotBeUndone: "Não pode ser desfeito.",
};
