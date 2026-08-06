export class UpdateProjectSettingsDto {
  terminalEnabled?: boolean;
  databaseEnabled?: boolean;
  autoDeployEnabled?: boolean;
  deployBranch?: string;
  diskLimitMb?: number | null;
}
