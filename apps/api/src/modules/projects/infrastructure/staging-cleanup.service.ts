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
 * Container de TESTE (staging) encontrado na varredura.
 */
export interface StagingContainerCandidate {
  id: string;
  name: string;
  /** Job de deploy associado (label korrelo.deployJobId). */
  deployJobId: string | null;
  /** true quando nenhum job está usando esse container (órfão). */
  orphaned: boolean;
}

/**
 * VARREDURA DE STAGING (Wave 2.1 - ajuste final).
 *
 * REGRA ABSOLUTA: o STARTUP DO KORRELO É 100% READ-ONLY NO DOCKER.
 *
 * O boot pode: `docker inspect`, `docker ps`, ler stats, detectar drift,
 * reconciliar metadados no Core e IDENTIFICAR staging órfão. Ele NÃO pode
 * (e não faz) `docker rm`, `stop`, `restart`, `update`, `compose up/down/rm`,
 * nem recriar container, alterar memória, imagem, rede ou volume.
 *
 * A remoção de um container de teste acontece em DOIS casos e só nesses:
 *  1. no `finally` do DeployJob que criou aquele staging (caminho normal do
 *     deploy - ver DeployProjectUseCase);
 *  2. numa ação administrativa EXPLICITA (cleanupOrphanedStaging), que só
 *     remove container com a label efêmera E com job comprovadamente
 *     encerrado.
 */
@Injectable()
export class StagingCleanupService implements OnModuleInit {
  private readonly logger = new Logger(StagingCleanupService.name);

  constructor(
    @Inject(DEPLOY_JOB_REPOSITORY) private readonly deployJobRepository: DeployJobRepository,
  ) {}

  /**
   * Boot: SÓ varre e registra. Nenhuma escrita no Docker.
   */
  async onModuleInit(): Promise<void> {
    try {
      const candidates = await this.detectStagingContainers();
      const orphans = candidates.filter((candidate) => candidate.orphaned);
      if (orphans.length === 0) {
        this.logger.log("[deploy] varredura de staging: nenhum container de teste órfão encontrado");
        return;
      }
      // Registra (e marca o job como pendente de limpeza) - mas NÃO remove.
      for (const orphan of orphans) {
        await this.markJobPendingCleanup(orphan);
        this.logger.warn(
          `[deploy] container de teste órfão "${orphan.name}" DETECTADO (não removido: o startup é somente leitura). ` +
            "Remova com uma ação explícita: POST /deploy-jobs/cleanup-staging",
        );
      }
    } catch (error) {
      // Falha na varredura NUNCA impede o Core de subir.
      this.logger.warn(`[deploy] falha na varredura de staging (o Core segue normalmente): ${(error as Error).message}`);
    }
  }

  /**
   * Varredura SOMENTE LEITURA: lista os containers de teste (label efêmera) e
   * diz quais estão órfãos (job encerrado/inexistente).
   */
  async detectStagingContainers(): Promise<StagingContainerCandidate[]> {
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
      this.logger.warn("[deploy] não foi possível listar containers de staging (docker indisponível?)");
      return [];
    }

    const rows = list.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"));

    const candidates: StagingContainerCandidate[] = [];
    for (const [id, name, jobId] of rows) {
      if (!id) continue;

      let isActive = false;
      if (jobId) {
        const job = await this.deployJobRepository.findById(jobId);
        isActive = job?.isOpen === true;
        if (isActive) {
          this.logger.log(`[deploy] container de teste "${name}" em uso (deploy ${jobId} em andamento)`);
        }
      }

      candidates.push({
        id,
        name: name ?? id,
        deployJobId: jobId || null,
        orphaned: !isActive,
      });
    }

    return candidates;
  }

  /**
   * LIMPEZA EXPLICITA (ação do administrador).
   *
   * Remove SOMENTE containers de teste:
   *  - com a label `korrelo.ephemeral=true` (listados por ela);
   *  - cujo nome termina em "-staging" (confirmação extra);
   *  - cujo job NÃO está em aberto (queued/running).
   *
   * Um container de PRODUÇÃO nunca é removido: ele não tem a label efêmera
   * e o nome não termina em "-staging". Mesmo que alguém rotule errado um
   * container de produção, as duas verificações impedem a remoção.
   */
  async cleanupOrphanedStaging(): Promise<{ removed: string[]; kept: string[]; skipped: string[] }> {
    const removed: string[] = [];
    const kept: string[] = [];
    const skipped: string[] = [];

    const candidates = await this.detectStagingContainers();

    for (const candidate of candidates) {
      if (!candidate.orphaned) {
        kept.push(candidate.name);
        continue;
      }

      // Confirmação extra: só remove container de TESTE pelo nome.
      if (!candidate.name.endsWith("-staging")) {
        skipped.push(candidate.name);
        this.logger.warn(
          `[deploy] container "${candidate.name}" tem a label efêmera mas não parece de teste - NÃO removido`,
        );
        continue;
      }

      try {
        await runCommand("docker", ["rm", "-f", candidate.id], { timeoutMs: DOCKER_REMOVE_TIMEOUT_MS });
        removed.push(candidate.name);
        this.logger.warn(`[deploy] container de teste órfão "${candidate.name}" removido (limpeza explícita)`);
      } catch (error) {
        this.logger.warn(
          `[deploy] não foi possível remover o container de teste "${candidate.name}": ${(error as Error).message}`,
        );
      }
    }

    if (removed.length > 0) {
      this.logger.warn(`[deploy] ${removed.length} container(s) de teste órfão(s) removido(s) na limpeza explícita.`);
    }

    return { removed, kept, skipped };
  }

  /**
   * Marca o job como "pendente de limpeza" (metadado no Core - nenhuma
   * escrita no Docker). Só para jobs que ainda existem.
   */
  private async markJobPendingCleanup(orphan: StagingContainerCandidate): Promise<void> {
    if (!orphan.deployJobId) return;
    try {
      const job = await this.deployJobRepository.findById(orphan.deployJobId);
      if (!job) return;
      await this.deployJobRepository.save(
        job.withError(
          `Container de teste órfão detectado (${orphan.name}). Pendente de limpeza - o startup não remove containers.`,
          job.status,
        ),
      );
    } catch (error) {
      this.logger.warn(
        `[deploy] não foi possível registrar o staging pendente de limpeza do job ${orphan.deployJobId}: ${(error as Error).message}`,
      );
    }
  }
}
