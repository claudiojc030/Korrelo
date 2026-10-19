import { Injectable, Logger } from "@nestjs/common";

/**
 * Log estruturado de deploy.
 *
 * Todo log de deploy carrega os mesmos campos (job, projeto, commit e
 * etapa), pra dar pra filtrar e correlacionar depois - inclusive entre
 * builds diferentes na mesma VPS.
 *
 * NUNCA logamos token, senha, connection string ou conteúdo de .env: quem
 * chama esse logger só passa dados já sanitizados.
 */
export interface DeployLogContext {
  deployJobId: string;
  projectId: string;
  commitSha: string | null;
}

@Injectable()
export class DeployLogger {
  private readonly logger = new Logger("deploy");

  log(stage: string, context: DeployLogContext, message: string, extra?: Record<string, unknown>): void {
    this.logger.log(this.format(stage, context, message, extra));
  }

  warn(stage: string, context: DeployLogContext, message: string, extra?: Record<string, unknown>): void {
    this.logger.warn(this.format(stage, context, message, extra));
  }

  error(stage: string, context: DeployLogContext, message: string, extra?: Record<string, unknown>): void {
    this.logger.error(this.format(stage, context, message, extra));
  }

  private format(
    stage: string,
    context: DeployLogContext,
    message: string,
    extra?: Record<string, unknown>,
  ): string {
    const base = `job=${context.deployJobId} project=${context.projectId} commit=${context.commitSha ?? "?"} stage=${stage} | ${message}`;
    if (!extra || Object.keys(extra).length === 0) return base;
    try {
      return `${base} | ${JSON.stringify(extra)}`;
    } catch {
      return base;
    }
  }
}
