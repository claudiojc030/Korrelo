import { Controller, ConflictException, Get, Inject, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { DeployQueueService } from "../infrastructure/deploy-queue.service";
import { CompatibilityDryRunService } from "../infrastructure/compatibility-dry-run.service";
import { StagingCleanupService } from "../infrastructure/staging-cleanup.service";
import { ImageGcAuditService } from "../infrastructure/image-gc-audit.service";
import {
  DEPLOY_JOB_REPOSITORY,
  type DeployJobRepository,
} from "../domain/deploy-job.repository";

/**
 * Fila global de deploy (Wave 2).
 *
 * Endpoints pequenos e aditivos (a UI histórica de deploy continua
 * funcionando em /projects/:id/deploys):
 * - lista os jobs recentes (com o estado e a etapa de cada um);
 * - mostra os contadores da fila (fila, rodando, falhas, rollbacks);
 * - permite reexecutar um job interrompido/falho (retry controlado);
 * - permite retomar um job que ficou PAUSADO no startup (ação explícita);
 * - mostra o dry-run de compatibilidade (o que MUDARIA em cada projeto,
 *   sem aplicar nada).
 */
@Controller("deploy-jobs")
export class DeployJobsController {
  constructor(
    private readonly deployQueue: DeployQueueService,
    private readonly dryRun: CompatibilityDryRunService,
    private readonly stagingCleanup: StagingCleanupService,
    private readonly imageGcAudit: ImageGcAuditService,
    @Inject(DEPLOY_JOB_REPOSITORY) private readonly jobs: DeployJobRepository,
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

  /**
   * Auditoria ADMINISTRATIVA e SOMENTE LEITURA do planejador de imagens.
   *
   * - autenticada pelo guard global (mesmo acesso do painel);
   * - recusada enquanto houver job de deploy na fila/rodando (evita
   *   confundir estado transitório com estado atual);
   * - nunca remove nada, nunca habilita apply;
   * - respeita o modo KORRELO_IMAGE_GC_MODE (off/dry-run).
   */
  @Get("image-gc-audit")
  async imageGcAuditRun() {
    const [queued, running] = await Promise.all([
      this.jobs.findAllByStatus("queued"),
      this.jobs.findAllByStatus("running"),
    ]);
    if (queued.length > 0 || running.length > 0) {
      throw new ConflictException(
        apiError(
          "IMAGE_GC_AUDIT_BUSY",
          "Auditoria recusada: há deploy na fila ou em execução. Rode novamente quando a fila estiver ociosa.",
        ),
      );
    }
    const plan = await this.imageGcAudit.audit({ readOnly: true });
    return { auditedAt: new Date().toISOString(), ...plan };
  }

  /**
   * Limpeza EXPLICITA de containers de teste órfãos.
   *
   * O startup do Korrelo é somente leitura: ele apenas DETECTA (e registra)
   * staging órfão. A remoção só acontece aqui, por ação explícita - e nunca
   * alcança um container de produção (a remoção exige a label efêmera E o
   * nome de container de teste).
   */
  @Post("cleanup-staging")
  async cleanupStaging() {
    const outcome = await this.stagingCleanup.cleanupOrphanedStaging();
    return { ok: true, ...outcome };
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
