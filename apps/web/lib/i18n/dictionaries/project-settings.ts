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
};
