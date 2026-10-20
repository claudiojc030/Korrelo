"use strict";

/**
 * GUARDA DE RECURSOS do rollout do Core.
 *
 * O rollout roda `npm install` e três builds NA MESMA VPS que hospeda os
 * projetos de produção (Mesatta, Mongo, Evolution API, Postgres, Redis).
 * Já houve incidente de forte pressão do host durante build: o objetivo
 * aqui é que a atualização do Core NUNCA sacrifice os projetos.
 *
 * Regras:
 * - as medições são READ-ONLY (/proc/meminfo, /proc/loadavg, df);
 * - MemAvailable FÍSICO é o critério principal (swap livre NÃO substitui RAM);
 * - swap já em uso acima do limite = o box já está sob pressão -> adiar;
 * - nada é "parado", "reduzido" ou "reiniciado" para liberar recurso: se
 *   faltam recursos, o rollout é ADIADO e o operador decide;
 * - os thresholds são configuráveis por env (ver readThresholds).
 */

const fs = require("node:fs");
const os = require("node:os");

/**
 * Defaults conservadores para uma VPS de 1 vCPU / 4 GB com os projetos de
 * produção rodando na mesma máquina.
 *
 * memRequiredMb = 1200
 *   O build do Core pode chegar a ~1 GB de heap (teto definido abaixo). Com
 *   1.2 GB disponíveis, sobram ~1.3 GB para Mesatta + Mongo + Evolution +
 *   Postgres + Redis + PM2 + SO. Abaixo disso, o build competiria com os
 *   projetos e o box entraria em swap.
 *
 * swapUsedMaxMb = 512
 *   A VPS tem ~2 GB de swap. Mais de 512 MB já em disco significa que o
 *   box já trocou memória sob pressão (os projetos podem estar sofrendo).
 *
 * load1Max = 1.5
 *   Com 1 vCPU, load1 >= 1.5 já significa fila de execução: iniciar outro
 *   build agora atrasaria os projetos sem ganho real.
 *
 * diskFreeMinGb = 2
 *   node_modules + .next do build do web ocupam GBs; sem espaço, o build
 *   morre no meio (depois do git update).
 *
 * buildHeapMb = 1024
 *   Teto de heap dos processos Node do rollout (install/builds). 1 GB é
 *   suficiente para os builds deste projeto (shared-types, API NestJS e o
 *   Next do painel) e limita o pior caso: o build não consegue comer a RAM
 *   inteira da máquina. Configurável para subir se o build do web pedir.
 */
const DEFAULT_THRESHOLDS = {
  memRequiredMb: 1200,
  swapUsedMaxMb: 512,
  load1Max: 1.5,
  diskFreeMinGb: 2,
  buildHeapMb: 1024,
  niceLevel: 10,
  useIonice: true,
};

function readNumber(env, key, fallback) {
  const raw = env ? env[key] : undefined;
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = Number.parseFloat(String(raw));
  return Number.isFinite(value) ? value : fallback;
}

/** Thresholds configuráveis por env. */
function readThresholds(env = process.env) {
  return {
    memRequiredMb: readNumber(env, "KORRELO_ROLLOUT_MEM_REQUIRED_MB", DEFAULT_THRESHOLDS.memRequiredMb),
    swapUsedMaxMb: readNumber(env, "KORRELO_ROLLOUT_SWAP_USED_MAX_MB", DEFAULT_THRESHOLDS.swapUsedMaxMb),
    load1Max: readNumber(env, "KORRELO_ROLLOUT_LOAD1_MAX", DEFAULT_THRESHOLDS.load1Max),
    diskFreeMinGb: readNumber(env, "KORRELO_ROLLOUT_DISK_FREE_GB_MIN", DEFAULT_THRESHOLDS.diskFreeMinGb),
    buildHeapMb: readNumber(env, "KORRELO_ROLLOUT_BUILD_HEAP_MB", DEFAULT_THRESHOLDS.buildHeapMb),
    niceLevel: readNumber(env, "KORRELO_ROLLOUT_NICE_LEVEL", DEFAULT_THRESHOLDS.niceLevel),
    useIonice: String((env ? env.KORRELO_ROLLOUT_IONICE : "1") ?? "1") !== "0",
  };
}

/** Parse de /proc/meminfo (kB -> MB). */
function parseMemInfo(raw) {
  if (!raw) return null;
  const values = {};
  for (const line of String(raw).split("\n")) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s*kB/.exec(line.trim());
    if (match) values[match[1]] = Number.parseInt(match[2], 10);
  }
  if (!Number.isFinite(values.MemTotal)) return null;
  const toMb = (kb) => Math.round(kb / 1024);
  const swapTotalMb = Number.isFinite(values.SwapTotal) ? toMb(values.SwapTotal) : null;
  const swapFreeMb = Number.isFinite(values.SwapFree) ? toMb(values.SwapFree) : null;
  return {
    memTotalMb: toMb(values.MemTotal),
    memAvailableMb: Number.isFinite(values.MemAvailable) ? toMb(values.MemAvailable) : null,
    swapTotalMb,
    swapFreeMb,
    swapUsedMb:
      swapTotalMb !== null && swapFreeMb !== null ? Math.max(0, swapTotalMb - swapFreeMb) : null,
  };
}

/** Parse da saída de `df -k /`. */
function parseDfOutput(raw) {
  const lines = String(raw ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;
  const header = lines[0].split(/\s+/);
  const row = lines[lines.length - 1].split(/\s+/);
  const availableIndex = header.findIndex((h) => h.toLowerCase().startsWith("avail"));
  const totalIndex = header.findIndex((h) => /^(1024-blocks|1k-blocks|blocks|size)$/i.test(h.toLowerCase()));
  const availableKb =
    availableIndex >= 0 ? Number.parseInt(row[availableIndex], 10) : Number.parseInt(row[3], 10);
  if (!Number.isFinite(availableKb)) return null;
  const totalKb = totalIndex >= 0 ? Number.parseInt(row[totalIndex], 10) : null;
  return {
    diskAvailableGb: Math.round((availableKb / 1024 / 1024) * 100) / 100,
    diskTotalGb: Number.isFinite(totalKb) ? Math.round((totalKb / 1024 / 1024) * 100) / 100 : null,
  };
}

/**
 * Mede os recursos do host (READ-ONLY).
 *
 * - MemAvailable/swap: /proc/meminfo (Linux)
 * - load average: os.loadavg()
 * - disco: `df -k /`
 */
async function readHostResources({
  run,
  readFile = fs.readFileSync,
  loadavg = os.loadavg,
  platform = os.platform(),
} = {}) {
  const resources = {
    memAvailableMb: null,
    memTotalMb: null,
    swapUsedMb: null,
    swapTotalMb: null,
    load1: null,
    load5: null,
    load15: null,
    diskAvailableGb: null,
    diskTotalGb: null,
    measurable: false,
  };

  if (platform === "linux") {
    try {
      const mem = parseMemInfo(readFile("/proc/meminfo", "utf-8"));
      if (mem) {
        resources.memTotalMb = mem.memTotalMb;
        resources.memAvailableMb = mem.memAvailableMb;
        resources.swapTotalMb = mem.swapTotalMb;
        resources.swapUsedMb = mem.swapUsedMb;
      }
    } catch {
      /* sem /proc/meminfo */
    }
    try {
      const load = loadavg();
      if (Array.isArray(load)) {
        resources.load1 = load[0];
        resources.load5 = load[1];
        resources.load15 = load[2];
      }
    } catch {
      /* loadavg indisponível */
    }
  }

  if (typeof run === "function") {
    const df = await run("df", ["-k", "/"], { timeoutMs: 10_000 });
    if (df.code === 0) {
      const disk = parseDfOutput(df.stdout);
      if (disk) {
        resources.diskAvailableGb = disk.diskAvailableGb;
        resources.diskTotalGb = disk.diskTotalGb;
      }
    }
  }

  resources.measurable =
    resources.memAvailableMb !== null ||
    resources.swapUsedMb !== null ||
    resources.load1 !== null ||
    resources.diskAvailableGb !== null;

  return resources;
}

/**
 * Avalia os recursos contra os thresholds.
 *
 * Métrica indisponível (fora do Linux, sem /proc) NÃO bloqueia: o build
 * segue com os demais controles. Métrica disponível e fora do limite
 * bloqueia.
 */
function evaluateResources({ resources, thresholds } = {}) {
  const t = thresholds ?? readThresholds();
  const checks = [];
  const add = (name, ok, detail, measurable) => checks.push({ name, ok, detail, measurable });

  const memMeasurable = resources?.memAvailableMb !== null && resources?.memAvailableMb !== undefined;
  add(
    "memória disponível",
    !memMeasurable || resources.memAvailableMb >= t.memRequiredMb,
    memMeasurable
      ? `${resources.memAvailableMb} MB (exigido: ${t.memRequiredMb} MB)`
      : "indisponível",
    memMeasurable,
  );

  const swapMeasurable = resources?.swapUsedMb !== null && resources?.swapUsedMb !== undefined;
  add(
    "swap em uso",
    !swapMeasurable || resources.swapUsedMb <= t.swapUsedMaxMb,
    swapMeasurable
      ? `${resources.swapUsedMb} MB (máximo: ${t.swapUsedMaxMb} MB)`
      : "indisponível",
    swapMeasurable,
  );

  const loadMeasurable = resources?.load1 !== null && resources?.load1 !== undefined;
  add(
    "load average (1min)",
    !loadMeasurable || resources.load1 <= t.load1Max,
    loadMeasurable ? `${resources.load1} (máximo: ${t.load1Max})` : "indisponível",
    loadMeasurable,
  );

  const diskMeasurable = resources?.diskAvailableGb !== null && resources?.diskAvailableGb !== undefined;
  add(
    "disco livre",
    !diskMeasurable || resources.diskAvailableGb >= t.diskFreeMinGb,
    diskMeasurable
      ? `${resources.diskAvailableGb} GB (mínimo: ${t.diskFreeMinGb} GB)`
      : "indisponível",
    diskMeasurable,
  );

  const failed = checks.filter((check) => !check.ok);
  const safeToBuild = failed.length === 0;
  const measurableCount = checks.filter((check) => check.measurable).length;

  return {
    ok: safeToBuild,
    safeToBuild,
    reason: safeToBuild
      ? measurableCount === 0
        ? "métricas de recurso indisponíveis: prosseguindo com os demais controles"
        : "recursos dentro dos limites"
      : failed.map((check) => `${check.name}: ${check.detail}`).join("; "),
    checks,
    thresholds: t,
  };
}

/**
 * Envolve o comando de build/install em nice/ionice (se existirem).
 *
 * `ionice -c 3 nice -n 10 <comando>`: classe de I/O ociosa + prioridade
 * de CPU baixa. Não reduz a prioridade do PM2 nem dos containers.
 */
function wrapBuildCommand({ command, args = [], nice = false, ionice = false, niceLevel = 10 }) {
  let finalCommand = command;
  let finalArgs = [...args];
  if (ionice) {
    finalArgs = ["-c", "3", finalCommand, ...finalArgs];
    finalCommand = "ionice";
  }
  if (nice) {
    finalArgs = ["-n", String(niceLevel), finalCommand, ...finalArgs];
    finalCommand = "nice";
  }
  return { command: finalCommand, args: finalArgs };
}

/**
 * Env do heap para os subprocessos Node do rollout (install/builds/assets).
 *
 * NÃO mexe no NODE_OPTIONS global do servidor: vale só para o processo
 * filho que o rollout dispara.
 */
function buildEnv({ buildHeapMb, env = process.env } = {}) {
  const heapMb = Math.max(256, Math.round(buildHeapMb ?? DEFAULT_THRESHOLDS.buildHeapMb));
  const heap = `--max-old-space-size=${heapMb}`;
  const existing = env && env.NODE_OPTIONS ? String(env.NODE_OPTIONS).trim() : "";
  return { NODE_OPTIONS: existing ? `${existing} ${heap}` : heap };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  readThresholds,
  parseMemInfo,
  parseDfOutput,
  readHostResources,
  evaluateResources,
  wrapBuildCommand,
  buildEnv,
};
