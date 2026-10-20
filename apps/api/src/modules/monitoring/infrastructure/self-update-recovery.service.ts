import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SELF_UPDATER, type SelfUpdater } from "../domain/self-updater";
import { SELF_UPDATE_JOB_REPOSITORY, type SelfUpdateJobRepository } from "../domain/self-update-job.entity";

/**
 * RECUPERAÇÃO DO SELF-UPDATE no startup da API.
 *
 * Incidente real: o update morreu junto com a API (o PM2 matou a árvore) e
 * deixou o `self-update.lock` e o `worker-drain` órfãos. No boot seguinte a
 * API não sabia que existia um update em andamento e o próximo update era
 * recusado por causa do lock.
 *
 * O que esta rotina faz (e o que ela NÃO faz):
 * - classifica o job cujo runner não existe mais (interrupted/completed/
 *   failed) ✓;
 * - remove o lock e o drain ÓRFÃOS (só quando é comprovadamente stale: PID
 *   morto ou TTL vencido) ✓;
 * - NUNCA toca em container, volume, rede ou banco de projeto ✓ (o startup
 *   continua read-only para os projetos).
 */
@Injectable()
export class SelfUpdateRecoveryService implements OnModuleInit {
  private readonly logger = new Logger(SelfUpdateRecoveryService.name);

  constructor(
    @Inject(SELF_UPDATER) private readonly updater: SelfUpdater,
    @Inject(SELF_UPDATE_JOB_REPOSITORY) private readonly jobs: SelfUpdateJobRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const recovered = await this.updater.recoverInterruptedJobs();
      for (const job of recovered) {
        this.logger.warn(
          `[update] job ${job.id} estava interrompido (status ${job.status}); o Core pode ter ficado numa versão intermediária`,
        );
      }
      this.cleanupStaleArtifacts();
    } catch (error) {
      this.logger.warn(`[update] falha na recuperação de self-update: ${(error as Error).message}`);
    }
  }

  /**
   * Limpa o lock/drain órfãos do Core (NADA de Docker de projeto).
   *
   * - o lock só é removido se o PID registrado estiver morto (ou o arquivo
   *   estiver corrompido) - um lock de processo VIVO nunca é removido;
   * - o drain só é removido se estiver expirado (TTL) ou se o PID do dono
   *   estiver morto.
   */
  cleanupStaleArtifacts(): { lockRemoved: boolean; drainRemoved: boolean } {
    const stateDir = process.env.KORRELO_STATE_DIR ?? path.join(os.homedir(), ".korrelo");
    const lockPath = path.join(stateDir, "self-update.lock");
    const drainPath = process.env.KORRELO_DRAIN_FILE ?? path.join(stateDir, "worker-drain");

    const lockRemoved = this.removeIfStale(lockPath, "self-update.lock", (content) => {
      if (!content) return true;
      if (typeof content.pid === "number" && content.pid > 0) return !isProcessAlive(content.pid);
      return true;
    });

    const drainRemoved = this.removeIfStale(drainPath, "worker-drain", (content) => {
      if (!content) return false;
      if (typeof content.expiresAt === "number" && Date.now() > content.expiresAt) return true;
      if (typeof content.pid === "number" && content.pid > 0) return !isProcessAlive(content.pid);
      return false;
    });

    return { lockRemoved, drainRemoved };
  }

  private removeIfStale(
    filePath: string,
    label: string,
    isStale: (content: Record<string, unknown> | null) => boolean,
  ): boolean {
    if (!fs.existsSync(filePath)) return false;
    let content: Record<string, unknown> | null = null;
    try {
      content = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    } catch {
      content = null;
    }
    if (!isStale(content)) {
      this.logger.log(`[update] ${label} ainda válido (mantido)`);
      return false;
    }
    try {
      fs.rmSync(filePath, { force: true });
      this.logger.warn(`[update] ${label} órfão removido (stale)`);
      return true;
    } catch (error) {
      this.logger.warn(`[update] não foi possível remover ${label} órfão: ${(error as Error).message}`);
      return false;
    }
  }
}

/** O processo existe? (EPERM = existe, mas é de outro usuário). */
export function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && (error as NodeJS.ErrnoException).code === "EPERM");
  }
}
