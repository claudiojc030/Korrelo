export class UpdateProjectSettingsDto {
  terminalEnabled?: boolean;
  databaseEnabled?: boolean;
  autoDeployEnabled?: boolean;
  deployBranch?: string;
  diskLimitMb?: number | null;
  skipStagingTest?: boolean;
  memoryLimitMb?: number | null;
  /**
   * Confirmação explícita para reduzir o limite de memória de um projeto que
   * está rodando (sem isso, a API recusa a redução).
   */
  confirmMemoryReduction?: boolean;
  /**
   * Healthcheck Docker do container (opcional). Só é aplicado quando
   * `enabled` é true - o padrão (sem healthcheck) é o comportamento
   * conservador, que nunca reinicia a aplicação por lentidão.
   */
  healthcheck?: {
    enabled?: boolean;
    path?: string;
    intervalSeconds?: number;
    timeoutSeconds?: number;
    retries?: number;
    startPeriodSeconds?: number;
  };
}
