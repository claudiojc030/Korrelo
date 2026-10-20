import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import {
  MAX_STAGING_HEALTH_TIMEOUT_SECONDS,
  MIN_STAGING_HEALTH_TIMEOUT_SECONDS,
  MIN_STAGING_MEMORY_LIMIT_MB,
} from "../domain/staging-config";
import type { Project } from "../domain/project.entity";

const BRANCH_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/;

export interface UpdateProjectSettingsInput {
  terminalEnabled?: boolean;
  databaseEnabled?: boolean;
  autoDeployEnabled?: boolean;
  deployBranch?: string;
  // undefined = não mexe; null = remove o alerta; número = novo limite em MB.
  diskLimitMb?: number | null;
  skipStagingTest?: boolean;
  // undefined = não mexe; null = volta pro rateio automático; número = fixa esse limite.
  memoryLimitMb?: number | null;
  /**
   * Confirmação explícita para REDUZIR o limite de memória de um projeto
   * que está rodando. Sem isso, a redução é recusada (o container em
   * execução não pode ter a memória diminuída por acidente).
   */
  confirmMemoryReduction?: boolean;
  // Healthcheck Docker do container (opcional).
  healthcheck?: {
    enabled?: boolean;
    path?: string;
    intervalSeconds?: number;
    timeoutSeconds?: number;
    retries?: number;
    startPeriodSeconds?: number;
  } | null;
  /**
   * Limite de memória do container de TESTE (staging) deste projeto, em MB.
   * undefined = não mexe; null = volta pro rateio automático; número = fixa.
   * Vale SÓ para o container de teste - produção, banco e outros projetos
   * não são afetados.
   */
  stagingMemoryLimitMb?: number | null;
  /**
   * Timeout (segundos) da espera de health do container de TESTE.
   * undefined = não mexe; null = volta pro default; número = fixa.
   * Vale SÓ para o staging - a espera de health da produção não muda.
   */
  stagingHealthTimeoutSeconds?: number | null;
}

@Injectable()
export class UpdateProjectSettingsUseCase {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly repository: ProjectRepository) {}

  async execute(projectId: string, input: UpdateProjectSettingsInput): Promise<Project> {
    const project = await this.repository.findById(projectId);
    if (!project) {
      throw new NotFoundException(apiError("PROJECT_NOT_FOUND", `Projeto ${projectId} não encontrado`));
    }

    const deployBranch = input.deployBranch?.trim() || project.deployBranch;
    if (!BRANCH_NAME_PATTERN.test(deployBranch)) {
      throw new BadRequestException(
        apiError("INVALID_BRANCH_NAME", `Nome de branch inválido: "${deployBranch}".`),
      );
    }

    if (input.diskLimitMb !== undefined && input.diskLimitMb !== null && input.diskLimitMb <= 0) {
      throw new BadRequestException(
        apiError("INVALID_DISK_LIMIT", "O limite de disco precisa ser um número maior que zero (ou vazio pra desativar o alerta)."),
      );
    }

    if (input.memoryLimitMb !== undefined && input.memoryLimitMb !== null && input.memoryLimitMb < 128) {
      throw new BadRequestException(
        apiError("INVALID_MEMORY_LIMIT", "O limite de memória precisa ser de pelo menos 128 MB (ou vazio pra voltar ao rateio automático)."),
      );
    }

    // ------------------------------------------------------------------
    // Configuração de STAGING (só o container de TESTE).
    //
    // Validação CONSERVADORA:
    // - o limite de staging nunca pode ser menor que o piso de container;
    // - o limite de staging nunca pode passar do limite de PRODUÇÃO
    //   (container de teste maior que o app real não faz sentido e aperta a
    //   VPS): o que o Core conhece da produção é o limite OBSERVADO no
    //   Docker e, na falta dele, o limite fixo escolhido pelo admin;
    // - o timeout de health do staging fica entre 10 e 300s.
    // ------------------------------------------------------------------
    if (
      input.stagingMemoryLimitMb !== undefined &&
      input.stagingMemoryLimitMb !== null &&
      input.stagingMemoryLimitMb < MIN_STAGING_MEMORY_LIMIT_MB
    ) {
      throw new BadRequestException(
        apiError(
          "INVALID_STAGING_MEMORY_LIMIT",
          `O limite de memória do staging precisa ser de pelo menos ${MIN_STAGING_MEMORY_LIMIT_MB} MB ` +
            "(ou vazio pra voltar ao rateio automático).",
        ),
      );
    }

    const knownProductionLimitMb = project.productionMemoryLimitMb ?? project.memoryLimitMb ?? null;
    if (
      input.stagingMemoryLimitMb !== undefined &&
      input.stagingMemoryLimitMb !== null &&
      knownProductionLimitMb !== null &&
      input.stagingMemoryLimitMb > knownProductionLimitMb
    ) {
      throw new BadRequestException(
        apiError(
          "INVALID_STAGING_MEMORY_LIMIT",
          `O limite de memória do staging (${input.stagingMemoryLimitMb} MB) não pode passar do limite de ` +
            `produção do projeto (${knownProductionLimitMb} MB). O staging é um container de TESTE temporário - ` +
            `dar mais memória a ele do que ao app em produção aperta a VPS sem ganho.`,
        ),
      );
    }

    if (
      input.stagingHealthTimeoutSeconds !== undefined &&
      input.stagingHealthTimeoutSeconds !== null &&
      (input.stagingHealthTimeoutSeconds < MIN_STAGING_HEALTH_TIMEOUT_SECONDS ||
        input.stagingHealthTimeoutSeconds > MAX_STAGING_HEALTH_TIMEOUT_SECONDS)
    ) {
      throw new BadRequestException(
        apiError(
          "INVALID_STAGING_HEALTH_TIMEOUT",
          `O timeout de health do staging precisa ficar entre ${MIN_STAGING_HEALTH_TIMEOUT_SECONDS} e ` +
            `${MAX_STAGING_HEALTH_TIMEOUT_SECONDS} segundos (ou vazio pra voltar ao default).`,
        ),
      );
    }

    let updated = project.withSettings(
      input.terminalEnabled ?? project.terminalEnabled,
      input.databaseEnabled ?? project.databaseEnabled,
    );
    updated = updated.withAutoDeploy(input.autoDeployEnabled ?? project.autoDeployEnabled, deployBranch);
    if (input.diskLimitMb !== undefined) {
      updated = updated.withDiskLimit(input.diskLimitMb);
    }
    if (input.skipStagingTest !== undefined) {
      updated = updated.withSkipStagingTest(input.skipStagingTest);
    }
    if (input.memoryLimitMb !== undefined) {
      // Reduzir o limite de um projeto QUE ESTÁ RODANDO é perigoso (o
      // container pode morrer por OOM). Exige confirmação explícita.
      const observed = project.productionMemoryLimitMb;
      const isRunning = project.status === "running";
      if (
        input.memoryLimitMb !== null &&
        isRunning &&
        observed !== null &&
        input.memoryLimitMb < observed &&
        input.confirmMemoryReduction !== true
      ) {
        throw new BadRequestException(
          apiError(
            "MEMORY_REDUCTION_REQUIRES_CONFIRMATION",
            `O projeto está rodando com ${observed} MB. Reduzir para ${input.memoryLimitMb} MB exige confirmação explícita ` +
              "(reenvie com confirmMemoryReduction: true).",
          ),
        );
      }
      updated = updated.withMemoryLimit(input.memoryLimitMb);
      updated = updated.withMemoryLimitReductionApproved(
        input.confirmMemoryReduction === true ? true : project.memoryLimitReductionApproved,
      );
    }
    if (input.healthcheck !== undefined) {
      updated = updated.withHealthcheckConfig(
        input.healthcheck === null ? null : JSON.stringify(normalizeHealthcheck(input.healthcheck)),
      );
    }
    if (input.stagingMemoryLimitMb !== undefined || input.stagingHealthTimeoutSeconds !== undefined) {
      // undefined = não mexe; null = volta ao automático/default.
      updated = updated.withStagingConfig({
        stagingMemoryLimitMb:
          input.stagingMemoryLimitMb !== undefined
            ? input.stagingMemoryLimitMb
            : project.stagingMemoryLimitMb,
        stagingHealthTimeoutSeconds:
          input.stagingHealthTimeoutSeconds !== undefined
            ? input.stagingHealthTimeoutSeconds
            : project.stagingHealthTimeoutSeconds,
      });
    }

    return this.repository.save(updated);
  }
}

/**
 * Normaliza a configuração de healthcheck: valores fora da faixa são
 * ajustados para algo conservador (intervalo grande, start period
 * generoso) em vez de aceitos como vieram.
 */
function normalizeHealthcheck(input: NonNullable<UpdateProjectSettingsInput["healthcheck"]>) {
  return {
    enabled: input.enabled === true,
    path: (input.path ?? "/").startsWith("/") ? (input.path ?? "/") : `/${input.path ?? ""}`,
    intervalSeconds: clamp(input.intervalSeconds, 30, 5, 300),
    timeoutSeconds: clamp(input.timeoutSeconds, 5, 1, 60),
    retries: clamp(input.retries, 3, 1, 10),
    startPeriodSeconds: clamp(input.startPeriodSeconds, 120, 0, 600),
  };
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}
