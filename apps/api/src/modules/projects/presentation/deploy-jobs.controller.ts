import { Controller, Get, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { DeployQueueService } from "../infrastructure/deploy-queue.service";
import { CompatibilityDryRunService } from "../infrastructure/compatibility-dry-run.service";

/**
 * Fila global de deploy (Wave 2).
 *
 * Endpoints pequenos e aditivos (a UI histórica de deploy continua
 * funcionando em /projects/:id/deploys):
 * - lista os jobs recentes (com o estado e a etapa de cada um);
 * - mostra os contadores da fila (fila, rodando, falhas, rollbacks);
 * - permite reexecutar um job interrompido/falho (retry controlado);
 * - mostra o dry-run de compatibilidade (o que MUDARIA em cada projeto,
 *   sem aplicar nada).
 */
@Controller("deploy-jobs")
export class DeployJobsController {
  constructor(
    private readonly deployQueue: DeployQueueService,
    private readonly dryRun: CompatibilityDryRunService,
  ) {}

  @Get()
  recent(@Query("limit") limit?: string) {
    const parsed = Number.parseInt(limit ?? "20", 10);
    const safeLimit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 100) : 20;
    return this.deployQueue.findRecent(safeLimit);
  }

  @Get("stats")
  stats() {
    return this.deployQueue.getStats();
  }

  /**
   * Dry-run de compatibilidade: mostra o que aconteceria com cada projeto
   * (limite atual, limite calculado, limite efetivo, bancos, se dá pra
   * deployar agora) SEM alterar nada.
   */
  @Get("dry-run")
  async compatibilityDryRun() {
    return this.dryRun.run();
  }

  @Post(":id/retry")
  async retry(@Param("id") id: string) {
    const result = await this.deployQueue.retry(id);
    if (!result) {
      throw new NotFoundException(apiError("DEPLOY_JOB_NOT_FOUND", `Job de deploy "${id}" não encontrado.`));
    }
    return { ok: true, jobId: result.job.id, status: result.job.status, attempt: result.job.attempt };
  }

  /**
   * Retoma um job que ficou pausado no startup (job enfileirado antes da
   * atualização do Korrelo). Nenhum deploy é retomado automaticamente.
   */
  @Post(":id/resume")
  async resume(@Param("id") id: string) {
    const result = await this.deployQueue.resume(id);
    if (!result) {
      throw new NotFoundException(apiError("DEPLOY_JOB_NOT_FOUND", `Job de deploy "${id}" não encontrado.`));
    }
    return { ok: true, jobId: result.job.id, status: result.job.status };
  }
}
