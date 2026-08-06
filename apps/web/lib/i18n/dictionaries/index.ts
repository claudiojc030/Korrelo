import type { Locale } from "../locale";
import { commonEn, commonPt } from "./common";
import { navEn, navPt } from "./nav";
import { loginEn, loginPt } from "./login";
import { setupEn, setupPt } from "./setup";
import { dashboardEn, dashboardPt } from "./dashboard";
import { projectsEn, projectsPt } from "./projects";
import { projectDetailEn, projectDetailPt } from "./project-detail";
import { projectCronEn, projectCronPt } from "./project-cron";
import { projectDatabaseEn, projectDatabasePt } from "./project-database";
import { projectEnvEn, projectEnvPt } from "./project-env";
import { projectFilesEn, projectFilesPt } from "./project-files";
import { projectLogsEn, projectLogsPt } from "./project-logs";
import { projectTerminalEn, projectTerminalPt } from "./project-terminal";
import { projectSettingsEn, projectSettingsPt } from "./project-settings";
import { securityEn, securityPt } from "./security";
import { systemServicesEn, systemServicesPt } from "./system-services";
import { settingsEn, settingsPt } from "./settings";
import { apiErrorsEn, apiErrorsPt } from "./api-errors";
import { apiErrorsProjectsAEn, apiErrorsProjectsAPt } from "./api-errors-projects-a";
import { apiErrorsProjectsBEn, apiErrorsProjectsBPt } from "./api-errors-projects-b";
import { apiErrorsMiscEn, apiErrorsMiscPt } from "./api-errors-misc";

const en = {
  common: commonEn,
  nav: navEn,
  login: loginEn,
  setup: setupEn,
  dashboard: dashboardEn,
  projects: projectsEn,
  projectDetail: projectDetailEn,
  projectCron: projectCronEn,
  projectDatabase: projectDatabaseEn,
  projectEnv: projectEnvEn,
  projectFiles: projectFilesEn,
  projectLogs: projectLogsEn,
  projectTerminal: projectTerminalEn,
  projectSettings: projectSettingsEn,
  security: securityEn,
  systemServices: systemServicesEn,
  settings: settingsEn,
  apiErrors: { ...apiErrorsEn, ...apiErrorsProjectsAEn, ...apiErrorsProjectsBEn, ...apiErrorsMiscEn },
};

const pt: typeof en = {
  common: commonPt,
  nav: navPt,
  login: loginPt,
  setup: setupPt,
  dashboard: dashboardPt,
  projects: projectsPt,
  projectDetail: projectDetailPt,
  projectCron: projectCronPt,
  projectDatabase: projectDatabasePt,
  projectEnv: projectEnvPt,
  projectFiles: projectFilesPt,
  projectLogs: projectLogsPt,
  projectTerminal: projectTerminalPt,
  projectSettings: projectSettingsPt,
  security: securityPt,
  systemServices: systemServicesPt,
  settings: settingsPt,
  apiErrors: { ...apiErrorsPt, ...apiErrorsProjectsAPt, ...apiErrorsProjectsBPt, ...apiErrorsMiscPt },
};

export type Dictionary = typeof en;

export function getDictionary(locale: Locale): Dictionary {
  return locale === "en" ? en : pt;
}
