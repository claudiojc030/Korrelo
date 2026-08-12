import { Inject, Injectable } from "@nestjs/common";
import * as os from "node:os";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";

// RAM reservada pro próprio SO + Korrelo (api, web, nginx, ssh, etc) antes de
// classificar o tier - sem isso o cálculo assumia a VPS inteira disponível
// pros projetos, mas uma fatia sempre está ocupada só de manter o Korrelo e
// o sistema operacional de pé.
const RESERVED_OVERHEAD_MB = 400;
// Chão de segurança: nenhum projeto ganha menos que isso, mesmo que muitos
// projetos estejam rodando ao mesmo tempo numa VPS pequena.
const MIN_CONTAINER_MEMORY_MB = 128;

@Injectable()
export class ResourceBudgetCalculator {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository) {}

  // Divide a RAM disponível pelo número de projetos rodando, em vez de dar o
  // mesmo teto fixo pra cada um - com um só projeto na VPS, ele usa praticamente
  // tudo; ao colocar mais projetos, o orçamento de cada um encolhe sozinho pra
  // caber todos sem estourar a RAM da máquina.
  async getContainerMemoryLimitMb(currentProjectId: string): Promise<number> {
    const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
    const availableForProjectsMb = Math.max(512, totalMemMb - RESERVED_OVERHEAD_MB);

    const projects = await this.projectRepository.findAll();
    const runningIds = new Set(projects.filter((p) => p.status === "running").map((p) => p.id));
    runningIds.add(currentProjectId);
    const projectCount = runningIds.size;

    // Sem teto fixo por cima de propósito: com um projeto só na VPS, ele deve
    // poder usar praticamente toda a RAM disponível, não ficar preso a um
    // limite pensado pra quando há vários projetos dividindo o mesmo espaço.
    const shareMb = Math.floor(availableForProjectsMb / projectCount);
    return Math.max(MIN_CONTAINER_MEMORY_MB, shareMb);
  }
}
