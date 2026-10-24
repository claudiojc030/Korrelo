import { Inject, Injectable, Logger } from "@nestjs/common";
import * as os from "node:os";
import { classifyResourceTier, type SystemMetrics } from "@korrelo/shared-types";
import {
  SYSTEM_METRICS_COLLECTOR,
  type SystemMetricsCollector,
} from "../domain/system-metrics-collector";

/**
 * Cache curto + proteção contra cascata.
 *
 * Contexto (incidente de 19/10/2026): a coleta de métricas chamava
 * `docker stats` sem timeout. Quando o Docker ficava lento, a promise
 * "in-flight" nunca resolvia e TODAS as requisições do dashboard passavam a
 * esperar a mesma promise pendurada - o painel inteiro travava atrás do
 * Docker e o Nginx devolvia 504.
 *
 * O que esta classe garante:
 * - No máximo UMA coleta em andamento; requisições simultâneas compartilham
 *   a mesma promise (e ela é SEMPRE liberada, mesmo em caso de falha).
 * - A promise compartilhada nunca rejeita: quem chama recebe métricas
 *   (possivelmente desatualizadas), nunca uma exceção.
 * - Falhas consecutivas viram backoff exponencial e depois um circuito
 *   aberto: enquanto o Docker não responde, nem tentamos de novo.
 * - A última leitura válida fica em cache e é devolvida marcada como
 *   `stale`, em vez de zero ("0% de CPU" seria mentira).
 * - Recuperação automática: quando uma coleta volta a dar certo, o contador
 *   zera e o circuito fecha sozinho.
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Por quanto tempo uma leitura é considerada "fresca". */
const CACHE_TTL_MS = envInt("SYSTEM_METRICS_CACHE_TTL_MS", 3_000);
/** Quantas falhas consecutivas são necessárias pra declarar o circuito aberto. */
const FAILURE_THRESHOLD = envInt("SYSTEM_METRICS_FAILURE_THRESHOLD", 3);
/** Base do backoff exponencial entre tentativas. */
const BACKOFF_BASE_MS = envInt("SYSTEM_METRICS_BACKOFF_BASE_MS", 5_000);
/** Teto do backoff. */
const BACKOFF_MAX_MS = envInt("SYSTEM_METRICS_BACKOFF_MAX_MS", 60_000);
/**
 * Watchdog de uma coleta.
 *
 * Os comandos internos têm timeout de 4-6s; 20s dá folga de sobra. Se a
 * coleta passar disso (Docker travado, promise que não assenta), ela é
 * ABANDONADA: a falha entra no circuito e a leitura anterior é devolvida como
 * `stale`. Sem isso, o `inFlight` e o sinalizador do scheduler ficavam presos
 * para sempre.
 */
const COLLECT_TIMEOUT_MS = envInt("SYSTEM_METRICS_COLLECT_TIMEOUT_MS", 20_000);

/** Coleta que estourou o watchdog (não é erro do Docker em si). */
class CollectTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`coleta de métricas excedeu ${timeoutMs}ms`);
    this.name = "CollectTimeoutError";
  }
}

interface CacheEntry {
  value: SystemMetrics;
  expiresAt: number;
}

@Injectable()
export class GetSystemMetricsUseCase {
  private readonly logger = new Logger(GetSystemMetricsUseCase.name);

  private cached: CacheEntry | null = null;
  private lastGood: SystemMetrics | null = null;
  private inFlight: Promise<SystemMetrics> | null = null;
  /**
   * Coleta FÍSICA (a chamada ao collector) que pode ter sido abandonada pelo
   * watchdog e continuar viva. Enquanto ela não assentar, NÃO abrimos outra
   * operação no Docker - senão um Docker travado viraria uma pilha de
   * processos `docker stats` a cada minuto.
   */
  private pendingCollect: Promise<SystemMetrics> | null = null;

  private consecutiveFailures = 0;
  private nextAttemptAt = 0;
  private circuitOpen = false;

  constructor(
    @Inject(SYSTEM_METRICS_COLLECTOR) private readonly collector: SystemMetricsCollector,
  ) {}

  async execute(): Promise<SystemMetrics> {
    const now = Date.now();

    if (this.cached && this.cached.expiresAt > now) {
      return this.cached.value;
    }

    // Backoff/circuito aberto: NÃO toca no Docker. Devolve o último estado
    // conhecido (marcado como desatualizado) em vez de ficar pendurado.
    if (now < this.nextAttemptAt) {
      return this.staleOrDegraded();
    }

    // Coleta em andamento: compartilha a mesma promise. Nunca rejeita, então
    // nenhuma requisição fica esperando um erro.
    if (this.inFlight) {
      return this.inFlight;
    }

    const run = this.collectOnce();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      // Liberado SEMPRE (inclusive em caso de exceção inesperada): se a
      // referência ficasse presa, o dashboard ficaria esperando uma promise
      // morta para sempre.
      if (this.inFlight === run) {
        this.inFlight = null;
      }
    }
  }

  /** Estado interno, para diagnóstico/log. Não expõe dados sensíveis. */
  getStatus(): {
    consecutiveFailures: number;
    circuitOpen: boolean;
    nextAttemptAt: number;
    hasCachedValue: boolean;
    collecting: boolean;
    /** true quando a coleta física anterior ainda não terminou (abandonada pelo watchdog). */
    physicalCollectPending: boolean;
  } {
    return {
      consecutiveFailures: this.consecutiveFailures,
      circuitOpen: this.circuitOpen,
      nextAttemptAt: this.nextAttemptAt,
      hasCachedValue: this.lastGood !== null,
      collecting: this.inFlight !== null,
      physicalCollectPending: this.pendingCollect !== null,
    };
  }

  private async collectOnce(): Promise<SystemMetrics> {
    // Coleta física anterior ainda pendurada (o watchdog já devolveu stale,
    // mas o Docker não terminou): NÃO dispara outra.
    if (this.pendingCollect) {
      this.registerFailure("coleta_anterior_pendente");
      return this.staleOrDegraded();
    }

    const collect = this.collector.collect();
    this.pendingCollect = collect;
    // Libera a referência quando a coleta REALMENTE terminar (mesmo que já
    // tenha sido abandonada pelo watchdog). Nunca fica para sempre: o
    // command-runner garante que os comandos internos assentam.
    void collect
      .catch(() => undefined)
      .finally(() => {
        if (this.pendingCollect === collect) {
          this.pendingCollect = null;
        }
      });

    try {
      const metrics = await this.withTimeout(collect);

      if (metrics.dockerReachable === false) {
        // O Docker não respondeu (timeout/erro). A coleta de CPU/memória pode
        // estar boa, mas o painel não pode fingir que está tudo normal.
        this.registerFailure("docker_indisponivel");
        return this.staleOrDegraded(metrics);
      }

      this.registerSuccess();
      this.lastGood = metrics;
      this.cached = { value: metrics, expiresAt: Date.now() + CACHE_TTL_MS };
      return metrics;
    } catch (error) {
      // Timeout do watchdog e exceção do collector entram no MESMO circuito.
      // O resultado tardio da coleta abandonada é ignorado (só o vencedor do
      // race chega aqui), então ele nunca sobrescreve `cached`/`lastGood`.
      const reason = error instanceof CollectTimeoutError ? "coleta_travada" : "coleta_lancou_excecao";
      this.registerFailure(reason);
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[metrics] falha ao coletar métricas (${reason}): ${message}`);
      return this.staleOrDegraded();
    }
  }

  /**
   * Corre a coleta com um teto de tempo.
   *
   * `Promise.race` garante que o chamador (dashboard OU scheduler) nunca espera
   * mais que COLLECT_TIMEOUT_MS. A promise abandonada continua com seus
   * handlers anexados (nada de unhandled rejection) e é descartada quando
   * resolver.
   */
  private withTimeout(promise: Promise<SystemMetrics>): Promise<SystemMetrics> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new CollectTimeoutError(COLLECT_TIMEOUT_MS)), COLLECT_TIMEOUT_MS);
      timer.unref?.();
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private registerSuccess(): void {
    if (this.consecutiveFailures > 0) {
      this.logger.log("[metrics] coleta recuperada - circuito fechado");
    }
    this.consecutiveFailures = 0;
    this.nextAttemptAt = 0;
    this.circuitOpen = false;
  }

  private registerFailure(reason: string): void {
    this.consecutiveFailures += 1;

    const exponential = BACKOFF_BASE_MS * Math.pow(2, Math.max(0, this.consecutiveFailures - 1));
    const backoffMs = Math.min(BACKOFF_MAX_MS, exponential);
    this.nextAttemptAt = Date.now() + backoffMs;

    const wasOpen = this.circuitOpen;
    this.circuitOpen = this.consecutiveFailures >= FAILURE_THRESHOLD;

    this.logger.warn(
      `[metrics] coleta falhou (${reason}) - falha ${this.consecutiveFailures}/${FAILURE_THRESHOLD}, ` +
        `nova tentativa em ${backoffMs}ms${this.circuitOpen ? ", circuito aberto" : ""}`,
    );

    if (this.circuitOpen && !wasOpen) {
      this.logger.warn(
        "[metrics] circuito aberto - o dashboard passa a mostrar o último valor conhecido até o Docker responder",
      );
    }
  }

  /**
   * Última leitura válida (marcada como desatualizada) ou, se nunca houve
   * uma leitura boa, um objeto explicitamente "indisponível" - nunca zeros
   * silenciosos que a UI interpretaria como "0% de CPU, tudo tranquilo".
   */
  private staleOrDegraded(fallback?: SystemMetrics): SystemMetrics {
    if (this.lastGood) {
      return { ...this.lastGood, stale: true, dockerReachable: false };
    }
    if (fallback) {
      return { ...fallback, stale: true, dockerReachable: false };
    }
    return this.degradedMetrics();
  }

  private degradedMetrics(): SystemMetrics {
    const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
    return {
      // Sem medição: null (a UI mostra "Coletando..."), nunca 0% - que
      // pareceria "host ocioso" quando na verdade não se sabe.
      cpuPercent: null,
      totalMemMb,
      freeMemMb: Math.round(os.freemem() / 1024 / 1024),
      usedMemPercent: 0,
      diskTotalGb: null,
      diskFreeGb: null,
      usedDiskPercent: null,
      uptimeSeconds: Math.round(os.uptime()),
      tier: classifyResourceTier(totalMemMb),
      containers: [],
      stale: true,
      available: false,
      dockerReachable: false,
      collectedAt: new Date().toISOString(),
    };
  }
}
