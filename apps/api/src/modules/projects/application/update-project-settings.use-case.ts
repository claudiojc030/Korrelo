import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
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
  // Healthcheck Docker do container (opcional).
  healthcheck?: {
    enabled?: boolean;
    path?: string;
    intervalSeconds?: number;
    timeoutSeconds?: number;
    retries?: number;
    startPeriodSeconds?: number;
  } | null;
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
      updated = updated.withMemoryLimit(input.memoryLimitMb);
    }
    if (input.healthcheck !== undefined) {
      updated = updated.withHealthcheckConfig(
        input.healthcheck === null ? null : JSON.stringify(normalizeHealthcheck(input.healthcheck)),
      );
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
