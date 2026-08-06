import { Inject, Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { ProjectDiskUsageService } from "./project-disk-usage.service";
import { getProjectWorkspacePath } from "./workspace-paths";

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
// Não manda alerta de novo pro mesmo projeto antes desse tempo, mesmo se ele
// continuar acima do limite a cada checagem horária.
const RE_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Alerta, não bloqueio: o Docker (overlay2 padrão) não segura quota de disco
// por container sem reparticionar a VPS inteira em XFS, então isso só avisa
// via ntfy.sh (reaproveita o mesmo tópico do alerta de falha de backup),
// nunca impede o projeto de continuar escrevendo.
@Injectable()
export class DiskUsageAlertScheduler {
  private readonly logger = new Logger(DiskUsageAlertScheduler.name);
  private readonly lastAlertedAt = new Map<string, number>();

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    private readonly diskUsageService: ProjectDiskUsageService,
  ) {}

  @Interval(CHECK_INTERVAL_MS)
  async check(): Promise<void> {
    const topic = process.env.BACKUP_ALERT_NTFY_TOPIC;
    if (!topic) return;

    const projects = await this.projectRepository.findAll();
    for (const project of projects) {
      if (!project.diskLimitMb) continue;

      const usageMb = await this.diskUsageService.getUsageMb(getProjectWorkspacePath(project.id));
      if (usageMb <= project.diskLimitMb) {
        this.lastAlertedAt.delete(project.id);
        continue;
      }

      const last = this.lastAlertedAt.get(project.id);
      if (last && Date.now() - last < RE_ALERT_COOLDOWN_MS) continue;

      await this.notify(topic, project.name, usageMb, project.diskLimitMb);
      this.lastAlertedAt.set(project.id, Date.now());
    }
  }

  private async notify(topic: string, projectName: string, usageMb: number, limitMb: number): Promise<void> {
    try {
      await fetch(`https://ntfy.sh/${topic}`, {
        method: "POST",
        headers: { Title: "Korrelo: limite de disco" },
        body: `Projeto "${projectName}" está usando ${Math.round(usageMb)}MB, acima do limite de ${limitMb}MB configurado.`,
      });
    } catch (error) {
      this.logger.warn(`Falha ao mandar alerta de disco via ntfy.sh: ${error}`);
    }
  }
}
