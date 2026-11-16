import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { StagingRunRecoveryService } from "../application/staging-run-recovery.service";

/**
 * Recuperação periódica CONSERVADORA de StagingRun/leases.
 *
 * - roda no boot e a cada 5 minutos;
 * - não remove containers, redes, volumes nem arquivos;
 * - sem inventário completo do Docker, o serviço de recuperação não altera
 *   nada (fail-closed);
 * - falhas são logadas e nunca derrubam o Core.
 */
@Injectable()
export class StagingRunRecoveryScheduler implements OnModuleInit {
  private readonly logger = new Logger(StagingRunRecoveryScheduler.name);
  private running = false;

  constructor(private readonly recovery: StagingRunRecoveryService) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled()) return;
    await this.run("startup");
  }

  @Interval(300_000)
  async handleInterval(): Promise<void> {
    if (!this.enabled()) return;
    await this.run("interval");
  }

  private enabled(): boolean {
    return process.env.KORRELO_STAGING_ISOLATED_EXECUTION === "true";
  }

  private async run(trigger: "startup" | "interval"): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.recovery.recover();
      if (!result.ok) {
        this.logger.warn(
          `[staging-recovery] ${trigger}: recuperação não aplicada (${result.issues
            .map((issue) => issue.message)
            .join("; ")})`,
        );
        return;
      }
      if (result.expired.length > 0 || result.conflicts.length > 0 || result.orphans.length > 0) {
        this.logger.log(
          `[staging-recovery] ${trigger}: inspected=${result.inspected} ` +
            `expired=${result.expired.length} conflicts=${result.conflicts.length} ` +
            `orphans=${result.orphans.length}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `[staging-recovery] ${trigger}: falha isolada na recuperação: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.running = false;
    }
  }
}
