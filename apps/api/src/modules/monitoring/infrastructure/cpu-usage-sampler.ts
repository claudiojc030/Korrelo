/**
 * AMOSTRAGEM DE CPU DO HOST (por delta de contadores).
 *
 * O PROBLEMA REAL (VPS de 1 vCPU): o cálculo antigo usava `os.cpus()` com
 * uma janela de 300 ms. Os contadores do Linux têm granularidade de 10 ms
 * (USER_HZ=100), então uma janela de 300 ms tem ~30 ticks - e basta o CPU
 * ficar ~30 ms ocupado (um `docker stats`, um `git fetch`, o próprio timer)
 * para o `idle` NÃO registrar nenhum tick. Com `idleDelta = 0`, o cálculo
 * dava 100% de CPU num host ocioso (load 0.01, vmstat idle 90%+).
 *
 * A CORREÇÃO: `/proc/stat` com DELTA entre duas amostras. O snapshot
 * anterior fica em memória e o percentual é a fração de tempo que NÃO foi
 * idle entre as duas leituras. Com o intervalo de coleta (1 min), a janela
 * é grande o bastante para ser estável e coerente com o `vmstat`/`top`.
 *
 * REGRAS (nenhuma delas pode ser furada):
 * 1. A PRIMEIRA amostra não tem delta: devolve null (nunca 100%);
 * 2. delta <= 0 (contador reiniciou, leitura inválida) -> null;
 * 3. o resultado é clampado em 0..100;
 * 4. nenhum número é inventado: se não deu para medir, é null.
 */

import * as fs from "node:fs";
import * as os from "node:os";

/** Fonte da medição (a UI mostra qual foi usada). */
export type CpuMeasurementSource = "proc-stat" | "fallback";

export interface CpuTimes {
  /** Soma de todos os tempos (user+nice+system+idle+iowait+irq+softirq+steal). */
  total: number;
  /** Tempo em que o host NÃO estava fazendo trabalho útil (idle + iowait). */
  idle: number;
}

export interface CpuSample {
  /** null = ainda não há medição válida (primeira amostra / leitura inválida). */
  percent: number | null;
  source: CpuMeasurementSource;
  /** Momento da leitura que originou a amostra. */
  sampledAt: string;
}

/**
 * Lê os contadores de CPU do `/proc/stat` (linha agregada "cpu ").
 *
 * A escolha de idle: **idle + iowait**. O iowait é tempo em que o
 * processo esperou I/O - o host não estava computando. Incluir no idle
 * evita que um host com I/O lento pareça "ocupado" (que é como o cálculo
 * antigo exaggerava o uso). O `total` soma TODOS os campos, então idle e
 * total vivem no mesmo universo.
 *
 * Retorna null quando o /proc/stat não existe (não-Linux) ou a linha está
 * corrompida.
 */
export function parseProcStatCpuTimes(content: string): CpuTimes | null {
  if (!content) return null;
  for (const line of content.split("\n")) {
    if (!line.startsWith("cpu ")) continue;
    const parts = line.trim().split(/\s+/).slice(1);
    if (parts.length < 4) return null;
    const values = parts.map((part) => Number.parseInt(part, 10));
    if (values.some((value) => !Number.isFinite(value) || value < 0)) return null;
    const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = values;
    const total = user + nice + system + idle + iowait + irq + softirq + steal;
    return { total, idle: idle + iowait };
  }
  return null;
}

/**
 * Percentual de CPU entre duas amostras.
 *
 * Retorna null quando não dá para medir (delta zero, contador reiniciado,
 * leitura inválida) - NUNCA 100% por falta de informação.
 */
export function computeCpuPercent(previous: CpuTimes | null, current: CpuTimes | null): number | null {
  if (!previous || !current) return null;
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  // Delta <= 0: contador reiniciou (ex.: reboot do host) ou leitura inválida.
  if (totalDelta <= 0) return null;
  if (idleDelta < 0 || idleDelta > totalDelta) return null;
  const percent = 100 * (1 - idleDelta / totalDelta);
  if (!Number.isFinite(percent)) return null;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

/** Soma os contadores de `os.cpus()` (fallback quando não há /proc/stat). */
export function sumOsCpuTimes(): CpuTimes | null {
  const cpus = os.cpus();
  if (!cpus || cpus.length === 0) return null;
  let total = 0;
  let idle = 0;
  for (const cpu of cpus) {
    const times = cpu.times;
    if (!times) return null;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
    idle += times.idle;
  }
  if (total <= 0) return null;
  return { total, idle };
}

/**
 * Amostrador de CPU: mantém o snapshot anterior em memória e calcula o
 * percentual por DELTA entre coletas.
 *
 * Uma instância por processo de coleta (o collector do Core) - o snapshot
 * persiste entre as coletas, que é o que dá a janela estável.
 */
export class CpuUsageSampler {
  private previous: CpuTimes | null = null;
  private previousSource: CpuMeasurementSource | null = null;
  private lastValidPercent: number | null = null;
  private lastValidAt = 0;

  constructor(
    private readonly readProcStat: () => string | null = defaultReadProcStat,
    private readonly readOsCpuTimes: () => CpuTimes | null = sumOsCpuTimes,
  ) {}

  /**
   * Coleta uma amostra.
   *
   * - primeira vez (ou leitura inválida): percent = null;
   * - leitura válida: percent = delta contra o snapshot anterior.
   */
  sample(): CpuSample {
    const sampledAt = new Date().toISOString();
    const procStat = this.readProcStat();
    const fromProc = procStat === null ? null : parseProcStatCpuTimes(procStat);
    if (fromProc) {
      const percent = computeCpuPercent(this.previous, fromProc);
      this.previous = fromProc;
      this.previousSource = "proc-stat";
      return {
        percent: this.resolve(percent),
        source: "proc-stat",
        sampledAt,
      };
    }

    // Fallback: os.cpus() com o MESMO esquema de duas amostras (sem sleep
    // e sem inventar número).
    const fromOs = this.readOsCpuTimes();
    if (!fromOs) {
      return { percent: this.lastValidPercent, source: "fallback", sampledAt };
    }
    const percent =
      this.previousSource === "fallback" ? computeCpuPercent(this.previous, fromOs) : null;
    this.previous = fromOs;
    this.previousSource = "fallback";
    return { percent: this.resolve(percent), source: "fallback", sampledAt };
  }

  /**
   * Quando o delta não dá para ser medido, devolve null (nunca 100%).
   *
   * A ÚNICA exceção é manter o último valor válido por uma janela CURTA
   * (evita o "—" piscando a cada coleta por causa de um counter reset
   * momentâneo) - e NUNCA vale para o primeiro dado, que é null.
   */
  private resolve(percent: number | null): number | null {
    if (percent !== null) {
      this.lastValidPercent = percent;
      this.lastValidAt = Date.now();
      return percent;
    }
    if (
      this.lastValidPercent !== null &&
      Date.now() - this.lastValidAt <= LAST_VALID_WINDOW_MS
    ) {
      return this.lastValidPercent;
    }
    return null;
  }
}

/** Janela curta em que o último valor válido é reaproveitado. */
const LAST_VALID_WINDOW_MS = 5 * 60 * 1000;

/** Leitura do /proc/stat (injetável nos testes). */
function defaultReadProcStat(): string | null {
  try {
    return fs.readFileSync("/proc/stat", "utf-8");
  } catch {
    return null;
  }
}
