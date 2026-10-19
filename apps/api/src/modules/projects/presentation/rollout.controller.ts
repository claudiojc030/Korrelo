import { Controller, Get } from "@nestjs/common";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Status do último rollout do Korrelo (mínimo, sem segredos).
 *
 * O arquivo de status é escrito pelo script de rollout em
 * ~/.korrelo/rollouts/last.json. Aqui só é LIDO - o endpoint não executa
 * nada, não toca em container e não reinicia processo.
 */
@Controller("rollout")
export class RolloutController {
  private get statusFile(): string {
    return path.join(os.homedir(), ".korrelo", "rollouts", "last.json");
  }

  @Get("status")
  status() {
    try {
      const raw = fs.readFileSync(this.statusFile, "utf-8");
      return { available: true, ...(JSON.parse(raw) as Record<string, unknown>) };
    } catch {
      return {
        available: false,
        status: "unknown",
        message: "Nenhum rollout registrado neste Core ainda.",
      };
    }
  }
}
