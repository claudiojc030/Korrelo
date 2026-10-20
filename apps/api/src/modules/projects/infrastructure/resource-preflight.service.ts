import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import * as os from "node:os";
import { readFileSync } from "node:fs";
import { runCommand } from "../../../infrastructure/command-runner";
import {
  evaluateHostResources,
  readBuildThresholds,
  readHostResources,
  realHostResourceProvider,
  type HostResourceEvaluation,
  type HostResourceProvider,

} from "../../../infrastructure/host-resources";

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
  /** Avaliação detalhada dos sinais do host (load, swap, PSI). */
  host?: HostResourceEvaluation;
}

const DOCKER_CHECK_TIMEOUT_MS = 3_000;
const DISK_CHECK_TIMEOUT_MS = 5_000;

/** Token do provider de métricas do host (injetável nos testes). */
export const HOST_RESOURCE_PROVIDER = Symbol("HOST_RESOURCE_PROVIDER");

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
   * Provider das métricas do host (injetável para os testes; em produção
   * é o provider real).
   */
  private readonly resourceProvider: HostResourceProvider;

  constructor(
    @Optional()
    @Inject(HOST_RESOURCE_PROVIDER)
    resourceProvider?: HostResourceProvider,
  ) {
    this.resourceProvider = resourceProvider ?? realHostResourceProvider;
  }

  /**
   * Espera (com cooldown) o host ficar seguro para um build pesado.
   *
   * Não é o mesmo que o preflight: aqui a espera acontece NOVAIS, dentro
   * do job de deploy, logo antes do build começar. A pressão depois do
   * `npm ci`/fetch é transitória - abortar o deploy por causa dela é
   * desperdício.
   *
   * A produção em execução NUNCA é parada, reduzida ou reiniciada para
   * liberar recurso: no máximo o build espera.
   */
  async waitForSafeHost(options: {
    timeoutSec?: number;
    intervalSec?: number;
    requiredMemoryMb?: number;
    requiredDiskMb?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    log?: (message: string) => void;
  } = {}): Promise<{ safe: boolean; reason: string | null; waitedSec: number; attempts: number }> {
    const timeoutSec = options.timeoutSec ?? envInt("KORRELO_BUILD_WAIT_TIMEOUT_SEC", 180);
    const intervalSec = Math.max(1, options.intervalSec ?? envInt("KORRELO_BUILD_WAIT_INTERVAL_SEC", 10));
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const now = options.now ?? (() => Date.now());
    const log = options.log ?? ((message: string) => this.logger.warn(message));
    const thresholds = readBuildThresholds();

    const startedAt = now();
    let attempts = 0;
    let lastReason: string | null = null;

    for (;;) {
      attempts += 1;
      const resources = await readHostResources({
        provider: this.resourceProvider,
        measureSwapActivity: true,
      });
      const evaluation = evaluateHostResources({
        resources,
        thresholds: {
          ...thresholds,
          memAvailableMb: options.requiredMemoryMb ?? thresholds.memAvailableMb,
          diskFreeMb: options.requiredDiskMb ?? thresholds.diskFreeMb,
        },
      });
      if (evaluation.safe) {
        if (attempts > 1) {
          log(
            `[deploy] recursos normalizados após ${Math.round((now() - startedAt) / 1000)}s ` +
              `(${evaluation.reason})`,
          );
        }
        return {
          safe: true,
          reason: null,
          waitedSec: Math.round((now() - startedAt) / 1000),
          attempts,
        };
      }

      lastReason = evaluation.reason;
      const elapsedSec = Math.round((now() - startedAt) / 1000);
      if (elapsedSec + intervalSec > timeoutSec) {
        return { safe: false, reason: lastReason, waitedSec: elapsedSec, attempts };
      }
      log(
        `[deploy] aguardando recursos para o build (${evaluation.reason}); ` +
          `tentativa=${attempts}, próxima checagem em ${intervalSec}s`,
      );
      await sleep(intervalSec * 1000);
    }
  }

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
    /** Informa se o Docker responde (evita a sonda real - usado nos testes). */
    dockerReachable?: boolean;
  }): Promise<PreflightResult> {
    const requiredMemoryMb = params.requiredMemoryMb ?? DEFAULT_BUILD_MEMORY_REQUIREMENT_MB;
    const requiredDiskMb = params.requiredDiskMb ?? DEFAULT_BUILD_DISK_REQUIREMENT_MB;
    const activeBuilds = params.activeBuilds ?? 0;
    const stagingReservationMb = params.stagingReservationMb ?? 0;
    const productionReservedMb = params.productionReservedMb ?? 0;

    const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
    // A memória livre vem do PROVIDER (mesma fonte dos outros sinais do
    // host: /proc/meminfo). O os.freemem() fica como fallback quando o
    // provider não tem a métrica.
    const providerMem = await this.resourceProvider.getMemInfo();
    const freeMemMb = providerMem?.memAvailableMb ?? Math.round(os.freemem() / 1024 / 1024);
    const { swapTotalMb, swapFreeMb } = this.readSwap();

    const diskFreeMb = await this.readDiskFreeMb();
    const dockerReachable =
      params.dockerReachable ?? (await this.isDockerReachable());

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

    // ------------------------------------------------------------------
    // Sinais do HOST (load, swap, PSI) - o mesmo conjunto validado no
    // rollout do Core. Uma VPS saturada NÃO deve começar um build: é
    // exatamente o que derrubou o Mesatta no incidente.
    // ------------------------------------------------------------------
    const hostThresholds = readBuildThresholds();
    const hostResources = await readHostResources({
      provider: this.resourceProvider,
      measureSwapActivity: true,
    });
    const hostEvaluation = evaluateHostResources({
      resources: hostResources,
      thresholds: { ...hostThresholds, memAvailableMb: 0, diskFreeMb: 0 },
    });
    if (!hostEvaluation.safe) {
      return {
        ok: false,
        reason: `host sobrecarregado para build (${hostEvaluation.reason}). A produção não é tocada.`,
        metrics,
        host: hostEvaluation,
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
