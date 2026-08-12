import { Injectable } from "@nestjs/common";
import * as os from "node:os";
import { CONTAINER_MEMORY_LIMIT_MB, classifyResourceTier } from "@korrelo/shared-types";

// RAM reservada pro próprio SO + Korrelo (api, web, nginx, ssh, etc) antes de
// classificar o tier - sem isso o cálculo assumia a VPS inteira disponível
// pros projetos, mas uma fatia sempre está ocupada só de manter o Korrelo e
// o sistema operacional de pé.
const RESERVED_OVERHEAD_MB = 400;

@Injectable()
export class ResourceBudgetCalculator {
  getContainerMemoryLimitMb(): number {
    const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
    const availableForProjectsMb = Math.max(512, totalMemMb - RESERVED_OVERHEAD_MB);
    const tier = classifyResourceTier(availableForProjectsMb);
    return CONTAINER_MEMORY_LIMIT_MB[tier];
  }
}
