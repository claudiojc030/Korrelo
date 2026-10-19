import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { runCommand } from "../../../infrastructure/command-runner";
import {
  DEPLOY_JOB_REPOSITORY,
  type DeployJobRepository,
} from "../domain/deploy-job.repository";
import { KORRELO_DEPLOY_JOB_LABEL, KORRELO_EPHEMERAL_LABEL } from "./docker-compose-file-builder";

const DOCKER_LIST_TIMEOUT_MS = 10_000;
const DOCKER_REMOVE_TIMEOUT_MS = 30_000;

/**
 * Recuperacao de containers de STAGING orfaos (achado DEP-03 da auditoria).
 *
 * O staging e temporario: nao tem politica de restart e e removido no
 * `finally` de todo deploy. Mas, se a API MORRER no meio do deploy (kill -9,
 * OOM da VPS, reinicio da maquina), o container pode ficar no ar - e
 * CONTINUARIA CONSUMINDO RAM/porta/banco, e ainda assim subindo de novo
 * depois de um reboot.
 *
 * A limpeza NUNCA e as cegas: so sao removidos containers com a label
 * `korrelo.ephemeral=true` cujo job de deploy NAO esta mais em aberto
 * (queued/running). Container de um deploy em andamento e preservado.
 */
@Injectable()
export class StagingCleanupService implements OnModuleInit {
  private readonly logger = new Logger(StagingCleanupService.name);

  constructor(
    @Inject(DEPLOY_JOB_REPOSITORY) private readonly deployJobRepository: DeployJobRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.cleanupOrphanedStagingContainers();
    } catch (error) {
      this.logger.warn(`[deploy] falha na recuperacao de staging orfao: ${(error as Error).message}`);
    }
  }

  async cleanupOrphanedStagingContainers(): Promise<{ removed: string[]; kept: string[] }> {
    const removed: string[] = [];
    const kept: string[] = [];

    const list = await runCommand(
      "docker",
      [
        "ps",
        "-a",
        "--filter",
        `label=${KORRELO_EPHEMERAL_LABEL}=true`,
        "--format",
        `{{.ID}}\t{{.Names}}\t{{.Label "${KORRELO_DEPLOY_JOB_LABEL}"}}`,
      ],
      { timeoutMs: DOCKER_LIST_TIMEOUT_MS },
    );

    if (list.timedOut || list.exitCode !== 0) {
      this.logger.warn("[deploy] nao foi possivel listar containers de staging (docker indisponivel?)");
      return { removed, kept };
    }

    const rows = list.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"));

    for (const [id, name, jobId] of rows) {
      if (!id) continue;

      // Sem job associado (ou com job que nao esta mais em aberto), o
      // container e orfao: ninguem esta mais USING ele.
      let isActive = false;
      if (jobId) {
        const job = await this.deployJobRepository.findById(jobId);
        isActive = job?.isOpen === true;
      }

      if (isActive) {
        kept.push(name ?? id);
        this.logger.log(`[deploy] container de teste "${name}" mantido (deploy ${jobId} ainda em andamento)`);
        continue;
      }

      try {
        await runCommand("docker", ["rm", "-f", id], { timeoutMs: DOCKER_REMOVE_TIMEOUT_MS });
        removed.push(name ?? id);
        this.logger.warn(`[deploy] container de teste orfao "${name}" removido`);
      } catch (error) {
        this.logger.warn(
          `[deploy] nao foi possivel remover o container de teste "${name}": ${(error as Error).message}`,
        );
      }
    }

    if (removed.length > 0) {
      this.logger.warn(`[deploy] ${removed.length} container(s) de teste orfao(s) removido(s) na recuperacao.`);
    }

    return { removed, kept };
  }
}
