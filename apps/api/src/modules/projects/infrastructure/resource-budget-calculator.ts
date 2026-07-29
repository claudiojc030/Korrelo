import { Injectable } from "@nestjs/common";
import * as os from "node:os";
import { CONTAINER_MEMORY_LIMIT_MB, classifyResourceTier } from "@korrelo/shared-types";

@Injectable()
export class ResourceBudgetCalculator {
  getContainerMemoryLimitMb(): number {
    const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
    const tier = classifyResourceTier(totalMemMb);
    return CONTAINER_MEMORY_LIMIT_MB[tier];
  }
}
