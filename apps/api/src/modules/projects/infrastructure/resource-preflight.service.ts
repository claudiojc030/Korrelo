import { Injectable, Logger } from "@nestjs/common";
import * as os from "node:os";
import { readFileSync } from "node:fs";
import { runCommand } from "../../../infrastructure/command-runner";

/**
 * Verificação de recursos ANTES de começar um build.
 *
 * Regra da Wave 2: nunca iniciar um build pesado quando o host está sem
 * folga. O job volta pra fila (ou falha com mensagem clara) - a produção
 * continua intocada.
 *
 * O que é medido:
 * - RAM total e RAM livre (o build precisa de RAM livre, não de swap);
 * - swap (informativo: conta como folga parcial, não como recurso planejado);
 * - disco livre (build + imagem + cache);
 * - Docker respondendo (sem daemon, não dá pra buildar);
 * - builds ativos (a fila global já garante 1, mas é uma defesa extra).
 */
export interface PreflightMetrics {
  totalMemMb: number;
  freeMemMb: number;
  swapTotalMb: number;
  swapFreeMb: number;
  /** null = não deu pra medir o disco. */
  diskFreeMb: number | null;
  dockerReachable: boolean;
  activeBuilds: number;
  requiredMemoryMb: number;
  requiredDiskMb: number;
  /** Memória que os containers de PRODUÇÃO já reservam (intocável). */
  productionReservedMb: number;
  /** Memória que o container de teste vai reservar. */
  stagingReservationMb: number;
  /** Memória realmente disponível para o build. */
  availableForBuildMb: number;
}

export interface PreflightResult {
  ok: boolean;
  reason: string | null;
  metrics: PreflightMetrics;
}

const DOCKER_CHECK_TIMEOUT_MS = 3_000;
const DISK_CHECK_TIMEOUT_MS = 5_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** RAM (em MB) que um build precisa livre para não derrubar a VPS. */
export const DEFAULT_BUILD_MEMORY_REQUIREMENT_MB = envInt("KORRELO_BUILD_MEMORY_REQUIREMENT_MB", 1_024);
/** Disco livre (em MB) que o build precisa. */
export const DEFAULT_BUILD_DISK_REQUIREMENT_MB = envInt("KORRELO_BUILD_DISK_REQUIREMENT_MB", 2_000);
/** Margem de segurança mantida livre durante o build. */
export const DEFAULT_BUILD_SAFETY_MARGIN_MB = envInt("KORRELO_BUILD_SAFETY_MARGIN_MB", 256);

@Injectable()
export class ResourcePreflightService {
  private readonly logger = new Logger(ResourcePreflightService.name);

  /**
   * Verifica se há headroom para um build + container de teste.
   *
   * PRIORIDADE: a produção existente. O cálculo é:
   *
   *   memória livre real (os containers de produção JÁ estão descontados)
   *     − margem de segurança
   *     − reserva do container de teste (que vai subir junto do build)
   *   = memória disponível para o build
   *
   * Se não sobrar, o build NÃO começa. A produção nunca é reduzida,
   * parada ou reiniciada pra "cabar" espaço.
   */
  async check(params: {
    requiredMemoryMb?: number;
    requiredDiskMb?: number;
    activeBuilds?: number;
    /** Memória que o container de teste vai reservar. */
    stagingReservationMb?: number;
    /** Soma dos limites dos containers de produção já rodando. */
    productionReservedMb?: number;
  }): Promise<PreflightResult> {
    const requiredMemoryMb = params.requiredMemoryMb ?? DEFAULT_BUILD_MEMORY_REQUIREMENT_MB;
    const requiredDiskMb = params.requiredDiskMb ?? DEFAULT_BUILD_DISK_REQUIREMENT_MB;
    const activeBuilds = params.activeBuilds ?? 0;
    const stagingReservationMb = params.stagingReservationMb ?? 0;
    const productionReservedMb = params.productionReservedMb ?? 0;

    const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
    const freeMemMb = Math.round(os.freemem() / 1024 / 1024);
    const { swapTotalMb, swapFreeMb } = this.readSwap();

    const diskFreeMb = await this.readDiskFreeMb();
    const dockerReachable = await this.isDockerReachable();

    const availableForBuildMb = Math.max(
      0,
      freeMemMb - DEFAULT_BUILD_SAFETY_MARGIN_MB - stagingReservationMb,
    );

    const metrics: PreflightMetrics = {
      totalMemMb,
      freeMemMb,
      swapTotalMb,
      swapFreeMb,
      diskFreeMb,
      dockerReachable,
      activeBuilds,
      requiredMemoryMb,
      requiredDiskMb,
      productionReservedMb,
      stagingReservationMb,
      availableForBuildMb,
    };

    if (activeBuilds > 0) {
      return {
        ok: false,
        reason: `já existe ${activeBuilds} build(s) em andamento`,
        metrics,
      };
    }

    if (!dockerReachable) {
      return { ok: false, reason: "Docker não respondeu", metrics };
    }

    if (availableForBuildMb < requiredMemoryMb) {
      return {
        ok: false,
        reason:
          `memória livre insuficiente para o build (${availableForBuildMb} MB disponíveis após a margem ` +
          `e a reserva do container de teste; o build precisa de ${requiredMemoryMb} MB. ` +
          `A produção em execução (${productionReservedMb} MB reservados) não é tocada).`,
        metrics,
      };
    }

    if (diskFreeMb !== null && diskFreeMb < requiredDiskMb) {
      return {
        ok: false,
        reason: `disco livre insuficiente (${diskFreeMb} MB, build precisa de ${requiredDiskMb} MB)`,
        metrics,
      };
    }

    return { ok: true, reason: null, metrics };
  }

  /** Swap total/livre. Em Linux vem do /proc/meminfo; fora disso, 0/0. */
  private readSwap(): { swapTotalMb: number; swapFreeMb: number } {
    try {
      if (process.platform !== "linux") return { swapTotalMb: 0, swapFreeMb: 0 };
      const content = readFileSync("/proc/meminfo", "utf-8");
      const total = /SwapTotal:\s+(\d+) kB/.exec(content);
      const free = /SwapFree:\s+(\d+) kB/.exec(content);
      return {
        swapTotalMb: total ? Math.round(Number(total[1]) / 1024) : 0,
        swapFreeMb: free ? Math.round(Number(free[1]) / 1024) : 0,
      };
    } catch {
      return { swapTotalMb: 0, swapFreeMb: 0 };
    }
  }

  private async readDiskFreeMb(): Promise<number | null> {
    try {
      const result = await runCommand("df", ["-k", "/"], { timeoutMs: DISK_CHECK_TIMEOUT_MS });
      if (result.timedOut || result.exitCode !== 0) return null;
      const lastLine = result.stdout.trim().split("\n").at(-1) ?? "";
      const parts = lastLine.split(/\s+/);
      const availableKb = Number(parts[3]);
      if (!availableKb || Number.isNaN(availableKb)) return null;
      return Math.round(availableKb / 1024);
    } catch {
      return null;
    }
  }

  private async isDockerReachable(): Promise<boolean> {
    try {
      const result = await runCommand("docker", ["ps", "--format", "{{.Names}}"], {
        timeoutMs: DOCKER_CHECK_TIMEOUT_MS,
      });
      return !result.timedOut && result.exitCode === 0;
    } catch {
      return false;
    }
  }
}
