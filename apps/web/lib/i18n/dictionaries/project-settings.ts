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
};
