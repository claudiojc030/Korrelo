import { readFileSync } from "node:fs";
import * as os from "node:os";

/**
 * MÉTRICAS DE RECURSO DO HOST (lado da API).
 *
 * O rollout do Core tem o mesmo conjunto de sinais em
 * `apps/api/scripts/rollout/lib/resource-guard.cjs` (que roda como processo
 * separado, em JavaScript puro). Aqui a mesma lógica em TypeScript, para o
 * deploy de projetos.
 *
 * REGRA CENTRAL (validada em produção): swap usada ALTA, sozinha, NÃO é
 * pressão de memória. O Linux mantém páginas antigas em swap mesmo depois
 * que a pressão passou. O bloqueio vem de:
 * - MemAvailable abaixo do mínimo;
 * - load acima do limite;
 * - disco abaixo do mínimo;
 * - ATIVIDADE de swap (delta de pswpin/pswpout na janela) - o que indica
 *   que o sistema está trocando memória AGORA;
 * - PSI de memória (some avg10 alto ou full avg10 > 0).
 *
 * Sem nenhum sinal disponível (host sem /proc), o fallback é CONSERVADOR
 * (bloqueia).
 */

export interface SwapActivity {
  available: boolean;
  swapInDelta: number | null;
  swapOutDelta: number | null;
}

export interface MemoryPressure {
  available: boolean;
  someAvg10: number | null;
  fullAvg10: number | null;
}

export interface HostResources {
  memAvailableMb: number | null;
  memTotalMb: number | null;
  swapUsedMb: number | null;
  swapTotalMb: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  diskAvailableMb: number | null;
  swapActivity: SwapActivity;
  memoryPressure: MemoryPressure;
}

export interface HostResourceThresholds {
  memAvailableMb: number;
  load1Max: number;
  diskFreeMb: number;
  swapActivityMaxPages: number;
  psiMemorySomeMax: number;
  psiMemoryFullMax: number;
}

export interface HostResourceProvider {
  getMemInfo(): Promise<{ memTotalMb: number | null; memAvailableMb: number | null; swapTotalMb: number | null; swapUsedMb: number | null } | null>;
  getLoadAverage(): Promise<[number, number, number] | null>;
  getDiskFreeMb(): Promise<number | null>;
  getSwapActivity(options?: { sampleMs?: number }): Promise<SwapActivity>;
  getMemoryPressure(): Promise<MemoryPressure>;
}

export interface HostResourceCheck {
  name: string;
  ok: boolean;
  detail: string;
  value: number | null;
  limit: number | null;
}

export interface HostResourceEvaluation {
  safe: boolean;
  reason: string;
  checks: HostResourceCheck[];
}

/** Parse de /proc/meminfo (kB -> MB). */
export function parseMemInfo(raw: string): {
  memTotalMb: number | null;
  memAvailableMb: number | null;
  swapTotalMb: number | null;
  swapUsedMb: number | null;
} | null {
  if (!raw) return null;
  const values: Record<string, number> = {};
  for (const line of raw.split("\n")) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s*kB/.exec(line.trim());
    if (match) values[match[1]] = Number.parseInt(match[2], 10);
  }
  if (!Number.isFinite(values.MemTotal)) return null;
  const toMb = (kb: number) => Math.round(kb / 1024);
  const swapTotalMb = Number.isFinite(values.SwapTotal) ? toMb(values.SwapTotal) : null;
  const swapFreeMb = Number.isFinite(values.SwapFree) ? toMb(values.SwapFree) : null;
  return {
    memTotalMb: toMb(values.MemTotal),
    memAvailableMb: Number.isFinite(values.MemAvailable) ? toMb(values.MemAvailable) : null,
    swapTotalMb,
    swapUsedMb:
      swapTotalMb !== null && swapFreeMb !== null ? Math.max(0, swapTotalMb - swapFreeMb) : null,
  };
}

/** Parse de /proc/vmstat (contadores ACUMULADOS desde o boot). */
export function parseVmstat(raw: string): { pswpin: number; pswpout: number } | null {
  if (!raw) return null;
  const values: Record<string, number> = {};
  for (const line of raw.split("\n")) {
    const match = /^(\w+)\s+(\d+)\s*$/.exec(line.trim());
    if (match) values[match[1]] = Number.parseInt(match[2], 10);
  }
  if (!Number.isFinite(values.pswpin) || !Number.isFinite(values.pswpout)) return null;
  return { pswpin: values.pswpin, pswpout: values.pswpout };
}

/** Parse de /proc/pressure/memory (Linux 4.20+). */
export function parsePsiMemory(raw: string): MemoryPressure & { someTotal: number | null; fullTotal: number | null } | null {
  if (!raw) return null;
  let someAvg10: number | null = null;
  let fullAvg10: number | null = null;
  let someTotal: number | null = null;
  let fullTotal: number | null = null;
  let sawSome = false;
  let sawFull = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("some ")) {
      sawSome = true;
      someAvg10 = parsePsiValue(trimmed, "avg10");
      someTotal = parsePsiValue(trimmed, "total");
    } else if (trimmed.startsWith("full ")) {
      sawFull = true;
      fullAvg10 = parsePsiValue(trimmed, "avg10");
      fullTotal = parsePsiValue(trimmed, "total");
    }
  }
  if (!sawSome && !sawFull) return null;
  return { available: true, someAvg10, fullAvg10, someTotal, fullTotal };
}

function parsePsiValue(line: string, key: string): number | null {
  const match = new RegExp(`${key}=([0-9.]+)`).exec(line);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

const sleepDefault = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/** Provider real (Linux). */
export const realHostResourceProvider: HostResourceProvider = {
  async getMemInfo() {
    if (process.platform !== "linux") return null;
    try {
      return parseMemInfo(readFileSync("/proc/meminfo", "utf-8"));
    } catch {
      return null;
    }
  },
  async getLoadAverage() {
    try {
      const load = os.loadavg();
      return Array.isArray(load) ? [load[0], load[1], load[2]] : null;
    } catch {
      return null;
    }
  },
  async getDiskFreeMb() {
    // Mantido aqui por simetria com o provider (a leitura de disco do
    // preflight de deploy usa o runCommand com timeout).
    return null;
  },
  async getSwapActivity(options = {}) {
    const sampleMs = options.sampleMs ?? 1000;
    const read = () => {
      try {
        return parseVmstat(readFileSync("/proc/vmstat", "utf-8"));
      } catch {
        return null;
      }
    };
    const first = read();
    if (!first) return { available: false, swapInDelta: null, swapOutDelta: null };
    await sleepDefault(sampleMs);
    const second = read();
    if (!second) return { available: false, swapInDelta: null, swapOutDelta: null };
    return {
      available: true,
      swapInDelta: Math.max(0, second.pswpin - first.pswpin),
      swapOutDelta: Math.max(0, second.pswpout - first.pswpout),
    };
  },
  async getMemoryPressure() {
    try {
      const parsed = parsePsiMemory(readFileSync("/proc/pressure/memory", "utf-8"));
      if (!parsed) return { available: false, someAvg10: null, fullAvg10: null };
      return { available: true, someAvg10: parsed.someAvg10, fullAvg10: parsed.fullAvg10 };
    } catch {
      return { available: false, someAvg10: null, fullAvg10: null };
    }
  },
};

/**
 * Provider FIXO e saudável (para os testes).
 *
 * Nenhum teste de deploy pode depender do load/RAM/disco da máquina que
 * roda o Jest (já quebrou uma suite inteira no CI).
 */
export function safeHostResourceProvider(
  overrides: {
    memAvailableMb?: number;
    memTotalMb?: number;
    swapUsedMb?: number;
    swapTotalMb?: number;
    load1?: number;
    diskFreeMb?: number;
    swapActivity?: SwapActivity;
    memoryPressure?: MemoryPressure;
  } = {},
): HostResourceProvider {
  const values = {
    memAvailableMb: 4096,
    memTotalMb: 8192,
    swapUsedMb: 0,
    swapTotalMb: 2048,
    load1: 0.1,
    diskFreeMb: 20 * 1024,
    swapActivity: { available: true, swapInDelta: 0, swapOutDelta: 0 } as SwapActivity,
    memoryPressure: { available: true, someAvg10: 0, fullAvg10: 0 } as MemoryPressure,
    ...overrides,
  };
  return {
    async getMemInfo() {
      return {
        memTotalMb: values.memTotalMb,
        memAvailableMb: values.memAvailableMb,
        swapTotalMb: values.swapTotalMb,
        swapUsedMb: values.swapUsedMb,
      };
    },
    async getLoadAverage() {
      return [values.load1, values.load1, values.load1];
    },
    async getDiskFreeMb() {
      return values.diskFreeMb;
    },
    async getSwapActivity() {
      return values.swapActivity;
    },
    async getMemoryPressure() {
      return values.memoryPressure;
    },
  };
}
/**
 * Lê os recursos do host (read-only).
 */
export async function readHostResources({
  provider = realHostResourceProvider,
  swapActivitySampleMs = 1000,
  measureSwapActivity = false,
}: {
  provider?: HostResourceProvider;
  swapActivitySampleMs?: number;
  measureSwapActivity?: boolean;
} = {}): Promise<HostResources> {
  const mem = await provider.getMemInfo();
  const load = await provider.getLoadAverage();
  const diskFreeMb = await provider.getDiskFreeMb();

  const resources: HostResources = {
    memAvailableMb: mem?.memAvailableMb ?? null,
    memTotalMb: mem?.memTotalMb ?? null,
    swapUsedMb: mem?.swapUsedMb ?? null,
    swapTotalMb: mem?.swapTotalMb ?? null,
    load1: load ? load[0] : null,
    load5: load ? load[1] : null,
    load15: load ? load[2] : null,
    diskAvailableMb: diskFreeMb,
    swapActivity: { available: false, swapInDelta: null, swapOutDelta: null },
    memoryPressure: { available: false, someAvg10: null, fullAvg10: null },
  };

  // A atividade de swap e o PSI só são medidos quando a swap usada está
  // acima do limite (o caso comum não paga o custo da amostragem).
  if (measureSwapActivity) {
    resources.swapActivity = await provider.getSwapActivity({ sampleMs: swapActivitySampleMs });
    resources.memoryPressure = await provider.getMemoryPressure();
  }

  return resources;
}

/**
 * Avalia os recursos contra os thresholds de build.
 *
 * `skipSwapUsed` (padrão: true) faz a swap usada ser apenas sinal
 * auxiliar: ela bloqueia sozinha apenas quando há sinal de pressão real
 * (atividade de swap ou PSI).
 */
export function evaluateHostResources({
  resources,
  thresholds,
}: {
  resources: HostResources;
  thresholds: HostResourceThresholds;
}): HostResourceEvaluation {
  const checks: HostResourceCheck[] = [];
  const add = (name: string, ok: boolean, detail: string, value: number | null, limit: number | null) => {
    checks.push({ name, ok, detail, value, limit });
  };

  const mem = resources.memAvailableMb;
  add(
    "memória disponível",
    mem === null || mem >= thresholds.memAvailableMb,
    mem === null ? "indisponível" : `${mem} MB (exigido: ${thresholds.memAvailableMb} MB)`,
    mem,
    thresholds.memAvailableMb,
  );

  const load = resources.load1;
  add(
    "load average (1min)",
    load === null || load <= thresholds.load1Max,
    load === null ? "indisponível" : `${load} (máximo: ${thresholds.load1Max})`,
    load,
    thresholds.load1Max,
  );

  const disk = resources.diskAvailableMb;
  add(
    "disco livre",
    disk === null || disk >= thresholds.diskFreeMb,
    disk === null ? "indisponível" : `${disk} MB (mínimo: ${thresholds.diskFreeMb} MB)`,
    disk,
    thresholds.diskFreeMb,
  );

  // Swap usada: sinal AUXILIAR. Só bloqueia com pressão real.
  const activity = resources.swapActivity;
  const psi = resources.memoryPressure;
  const activityKnown = activity?.available === true;
  const psiKnown = psi?.available === true;
  const swappedPages = activityKnown
    ? (activity.swapInDelta ?? 0) + (activity.swapOutDelta ?? 0)
    : null;
  const activityPressure = activityKnown && (swappedPages ?? 0) > thresholds.swapActivityMaxPages;
  const psiPressure =
    psiKnown &&
    ((psi.someAvg10 ?? 0) > thresholds.psiMemorySomeMax ||
      (psi.fullAvg10 ?? 0) > thresholds.psiMemoryFullMax);
  const unknownPressure = !activityKnown && !psiKnown;
  const swapUsed = resources.swapUsedMb;
  const swapPressure = swapUsed !== null && (activityPressure || psiPressure || unknownPressure);
  add(
    "swap em uso",
    !swapPressure,
    swapUsed === null
      ? "indisponível"
      : swapPressure
        ? `swap em uso ${swapUsed} MB COM pressão real ` +
          `(swap-in/out=${swappedPages ?? "?"} páginas, PSI some=${psi?.someAvg10 ?? "?"} full=${psi?.fullAvg10 ?? "?"})`
        : `${swapUsed} MB` +
          (swapUsed > 0
            ? ` - swap histórica (atividade=${swappedPages ?? "?"} páginas, PSI some=${psi?.someAvg10 ?? "?"} full=${psi?.fullAvg10 ?? "?"})`
            : ""),
    swapUsed,
    null,
  );

  const failed = checks.filter((check) => !check.ok);
  return {
    safe: failed.length === 0,
    reason:
      failed.length === 0
        ? "recursos dentro dos limites"
        : failed.map((check) => `${check.name}: ${check.detail}`).join("; "),
    checks,
  };
}

/** Thresholds do build (env). */
export function readBuildThresholds(env = process.env): HostResourceThresholds {
  return {
    // PISO de segurança do host: 1200 MB (o mesmo valor validado em
    // produção no resource guard do rollout do Core). É um PISO - nunca é
    // reduzido automaticamente. O build só começa com pelo menos isso
    // disponível, além das demais regras de budget/staging.
    memAvailableMb: envNumberFrom(env, "KORRELO_BUILD_MEM_AVAILABLE_MB", 1200),
    load1Max: envNumberFrom(env, "KORRELO_BUILD_LOAD1_MAX", 1.5),
    diskFreeMb: envNumberFrom(env, "KORRELO_BUILD_DISK_FREE_MB", 2000),
    swapActivityMaxPages: envNumberFrom(env, "KORRELO_BUILD_SWAP_ACTIVITY_MAX_PAGES", 512),
    psiMemorySomeMax: envNumberFrom(env, "KORRELO_BUILD_PSI_MEMORY_SOME_MAX", 1),
    psiMemoryFullMax: envNumberFrom(env, "KORRELO_BUILD_PSI_MEMORY_FULL_MAX", 0.01),
  };
}

function envNumberFrom(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
