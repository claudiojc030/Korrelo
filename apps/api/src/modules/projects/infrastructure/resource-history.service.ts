import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SystemMetrics } from "@korrelo/shared-types";
import {
  readHostResources,
  realHostResourceProvider,
  type HostResourceProvider,
} from "../../../infrastructure/host-resources";
import {
  ResourceHistory,
  classifyHistoryConfidence,
  type HistoryConfidence,
  type ResourceHistorySummary,
  type ResourceSample,
} from "../domain/resource-history";

/** Retenção padrão: 12 h (720 amostras de 1 min). */
const DEFAULT_RETENTION_MS = 12 * 60 * 60 * 1000;
const DEFAULT_MAX_SAMPLES = 720;
/** Persistência a cada 30 min: sobrevive a restart sem amplificar escrita. */
const DEFAULT_PERSIST_INTERVAL_MS = 30 * 60 * 1000;
/** Watchdog da leitura do host + amostra (não inclui a escrita síncrona). */
const DEFAULT_CAPTURE_TIMEOUT_MS = 15_000;
/** Log de "captura anterior ainda em andamento" no máximo a cada 10 min. */
const CAPTURE_SKIP_LOG_INTERVAL_MS = 10 * 60 * 1000;

/** Token opcional: em produção nada é fornecido; testes injetam opções. */
export const RESOURCE_HISTORY_OPTIONS = Symbol("RESOURCE_HISTORY_OPTIONS");

export interface ResourceHistoryOptions {
  provider?: HostResourceProvider;
  filePath?: string;
  persistIntervalMs?: number;
  retentionMs?: number;
  maxSamples?: number;
  captureTimeoutMs?: number;
}

/**
 * Resource Manager V1 — Fase A (somente observação).
 *
 * Captura UMA amostra por tick do scheduler de métricas já existente (60 s):
 * nada de timer novo, agente ou serviço permanente extra. Guarda no máximo
 * 12 h em memória e persiste a cada 30 min (arquivo JSON pequeno e atômico)
 * para sobreviver a restart.
 *
 * Custo: uma leitura de /proc + `docker stats` já feito pelo coletor. O
 * arquivo tem centenas de KB e é reescrito ~48 vezes por dia - não é um
 * banco de séries temporais.
 *
 * Falha de coleta nunca derruba o Core: apenas não registra a amostra.
 */
@Injectable()
export class ResourceHistoryService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ResourceHistoryService.name);
  private readonly history: ResourceHistory;
  private readonly provider: HostResourceProvider;
  private readonly filePath: string;
  private readonly persistIntervalMs: number;
  private readonly retentionMs: number;
  private readonly maxSamples: number;
  private readonly captureTimeoutMs: number;
  private lastPersistAt = 0;
  private capturing = false;
  private lastCaptureSkipLogAt = 0;

  constructor(
    @Optional()
    @Inject(RESOURCE_HISTORY_OPTIONS)
    options: ResourceHistoryOptions = {},
  ) {
    this.provider = options.provider ?? realHostResourceProvider;
    const stateDir = process.env.KORRELO_STATE_DIR ?? join(homedir(), ".korrelo");
    this.filePath =
      options.filePath ?? process.env.KORRELO_RESOURCE_HISTORY_FILE ?? join(stateDir, "resource-history.json");
    this.persistIntervalMs = options.persistIntervalMs ?? DEFAULT_PERSIST_INTERVAL_MS;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES;
    this.captureTimeoutMs =
      typeof options.captureTimeoutMs === "number" &&
      Number.isFinite(options.captureTimeoutMs) &&
      options.captureTimeoutMs > 0
        ? options.captureTimeoutMs
        : DEFAULT_CAPTURE_TIMEOUT_MS;
    this.history = new ResourceHistory({
      maxAgeMs: this.retentionMs,
      maxSamples: this.maxSamples,
    });
  }

  onModuleInit(): void {
    // Caminho efetivo no log de boot: em produção ele fica em
    // `$KORRELO_STATE_DIR/resource-history.json` (ou ~/.korrelo/...).
    this.logger.log(`[resources] histórico de recursos em ${this.filePath}`);
    this.load();
  }

  onApplicationShutdown(): void {
    this.persist(true);
  }

  /**
   * Registra uma amostra a partir das métricas já coletadas pelo scheduler.
   * `metrics` nulo (coleta falhou/stale) => não grava nada.
   *
   * A leitura do host tem watchdog próprio. Uma captura que não assenta não
   * pode segurar o scheduler do coletor: o scheduler também tem um limite,
   * mas o serviço não deve depender dele. Capturas sobrepostas são ignoradas
   * (a anterior ainda está em andamento).
   */
  async capture(metrics: SystemMetrics | null): Promise<boolean> {
    if (!metrics || metrics.available === false || metrics.stale === true) return false;
    if (isDisabledByEnv("KORRELO_RESOURCE_HISTORY_ENABLED")) return false;
    if (this.capturing) {
      const now = Date.now();
      if (now - this.lastCaptureSkipLogAt >= CAPTURE_SKIP_LOG_INTERVAL_MS) {
        this.logger.warn(
          "[resources] captura anterior ainda em andamento - amostra ignorada (o coletor de métricas segue)",
        );
        this.lastCaptureSkipLogAt = now;
      }
      return false;
    }

    this.capturing = true;
    try {
      const host = await withTimeout(
        readHostResources({
          provider: this.provider,
          measureSwapActivity: true,
        }),
        this.captureTimeoutMs,
        "leitura de recursos do host",
      );
      const sample: ResourceSample = {
        at: Date.now(),
        memAvailableMb: host.memAvailableMb,
        memTotalMb: host.memTotalMb,
        swapUsedMb: host.swapUsedMb,
        swapInDelta: host.swapActivity.swapInDelta,
        swapOutDelta: host.swapActivity.swapOutDelta,
        psiSome10: host.memoryPressure.someAvg10,
        psiFull10: host.memoryPressure.fullAvg10,
        load1: host.load1,
        hostCpuPercent: metrics.cpuPercent,
        containers: (metrics.containers ?? []).map((container) => ({
          name: container.name.replace(/^\//, ""),
          usageMb: container.memUsageMb,
          limitMb: container.memLimitMb,
          cpuPercent: container.cpuPercent,
        })),
      };
      this.history.add(sample);
      this.persist(false);
      return true;
    } catch (error) {
      this.logger.warn(
        `[resources] amostra ignorada (falha de coleta): ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    } finally {
      this.capturing = false;
    }
  }

  summary(containerName: string): ResourceHistorySummary | null {
    if (!containerName) return null;
    return this.history.summary(containerName);
  }

  /** Estado do histórico para o painel/diagnóstico (sem amostras brutas). */
  describe(containerName?: string | null): {
    samples: number;
    oldestAt: string | null;
    newestAt: string | null;
    container: ResourceHistorySummary["container"];
    host: ResourceHistorySummary["host"] | null;
    confidence: HistoryConfidence;
  } {
    const snapshot = this.snapshot();
    const summary = containerName ? this.summary(containerName) : null;
    return {
      ...snapshot,
      container: summary?.container ?? null,
      host: summary?.host ?? null,
      confidence: classifyHistoryConfidence(summary),
    };
  }

  snapshot(): { samples: number; oldestAt: string | null; newestAt: string | null } {
    const samples = this.history.all();
    return {
      samples: samples.length,
      oldestAt: samples.length > 0 ? new Date(samples[0].at).toISOString() : null,
      newestAt: samples.length > 0 ? new Date(samples[samples.length - 1].at).toISOString() : null,
    };
  }

  /**
   * Escrita ATÔMICA e restrita:
   * - arquivo temporário no MESMO diretório + `fsync` + `rename` (o leitor
   *   nunca vê JSON pela metade);
   * - modo 0600 no arquivo e 0700 no diretório criado (best effort em
   *   plataformas sem POSIX, como o Windows de desenvolvimento).
   *
   * O caminho fica fora do checkout e de qualquer diretório que o rollout,
   * o rollback ou a limpeza de staging removam.
   */
  private persist(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastPersistAt < this.persistIntervalMs) return;
    this.lastPersistAt = now;
    try {
      const dir = dirname(this.filePath);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temp = `${this.filePath}.tmp`;
      const payload = JSON.stringify(this.history.toJSON());
      const fd = openSync(temp, "w", 0o600);
      try {
        writeFileSync(fd, payload, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      restrictMode(temp);
      renameSync(temp, this.filePath);
      restrictMode(this.filePath);
    } catch (error) {
      this.logger.warn(
        `[resources] não foi possível persistir o histórico: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
      const loaded = ResourceHistory.fromJSON(raw, {
        maxAgeMs: this.retentionMs,
        maxSamples: this.maxSamples,
      });
      for (const sample of loaded.all()) this.history.add(sample);
      this.logger.log(`[resources] histórico carregado: ${this.history.size()} amostra(s)`);
    } catch {
      // Arquivo corrompido não impede o Core de subir; começa vazio.
      this.logger.warn("[resources] histórico ilegível; começando vazio");
    }
  }
}

function isDisabledByEnv(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "no" || raw === "off";
}

/** 0600 no arquivo. Best effort: no Windows o chmod é limitado, mas não falha. */
function restrictMode(filePath: string): void {
  try {
    chmodSync(filePath, 0o600);
  } catch {
    /* plataforma sem POSIX ou FS sem suporte a mode */
  }
}

class ResourceHistoryTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} excedeu ${timeoutMs}ms`);
    this.name = "ResourceHistoryTimeoutError";
  }
}

/** Timer unref'd: não atrasa o shutdown normal; o servidor mantém o loop vivo. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ResourceHistoryTimeoutError(label, timeoutMs)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
