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
 * PROVIDER REAL de métricas do host.
 *
 * A interface é pequena de propósito (getMemInfo / getLoadAverage /
 * getDiskFree) para que os TESTES injectem um provider fake e o resultado
 * dos testes nunca dependa da máquina onde o Jest está rodando (load
 * average real do CI, por exemplo, já quebrou uma suíte inteira).
 */
const realResourceProvider = {
  /** /proc/meminfo (Linux). */
  getMemInfo() {
    if (process.platform !== "linux") return null;
    try {
      return parseMemInfo(fs.readFileSync("/proc/meminfo", "utf-8"));
    } catch (error) {
      // Erro de LEITURA é diferente de "métrica indisponível": no Linux o
      // /proc/meminfo tem que estar legível. Isso é hard failure.
      return { error: String(error?.message ?? error) };
    }
  },
  /** load average do host. */
  getLoadAverage() {
    try {
      const load = os.loadavg();
      return Array.isArray(load) ? load : null;
    } catch {
      return null;
    }
  },
  /** `df -k /` (read-only). */
  async getDiskFree(run) {
    if (typeof run !== "function") return null;
    const df = await run("df", ["-k", "/"], { timeoutMs: 10_000 });
    if (df.code !== 0) return null;
    return parseDfOutput(df.stdout);
  },
};

/**
 * Mede os recursos do host (READ-ONLY).
 *
 * - MemAvailable/swap: /proc/meminfo (Linux)
 * - load average: os.loadavg()
 * - disco: `df -k /`
 *
 * `provider` permite injetar as métricas (usado nos testes).
 */
async function readHostResources({ run, provider = realResourceProvider } = {}) {
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
    readError: null,
    measurable: false,
  };

  const mem = await provider.getMemInfo();
  if (mem) {
    resources.memTotalMb = mem.memTotalMb ?? null;
    resources.memAvailableMb = mem.memAvailableMb ?? null;
    resources.swapTotalMb = mem.swapTotalMb ?? null;
    resources.swapUsedMb = mem.swapUsedMb ?? null;
    if (mem.error) resources.readError = String(mem.error);
  }

  const load = await provider.getLoadAverage();
  if (Array.isArray(load)) {
    resources.load1 = load[0] ?? null;
    resources.load5 = load[1] ?? null;
    resources.load15 = load[2] ?? null;
  }

  const disk = await provider.getDiskFree(run);
  if (disk) {
    resources.diskAvailableGb = disk.diskAvailableGb ?? null;
    resources.diskTotalGb = disk.diskTotalGb ?? null;
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
 *
 * Cada check carrega `value` e `limit` para que a política
 * transient/hard e os logs possam falar em números.
 */
function evaluateResources({ resources, thresholds } = {}) {
  const t = thresholds ?? readThresholds();
  const checks = [];
  const add = (name, ok, detail, measurable, value = null, limit = null) =>
    checks.push({ name, ok, detail, measurable, value, limit });

  const readError = resources?.readError ?? null;
  add(
    "leitura de recursos",
    !readError,
    readError ? `falha ao ler métricas do host: ${readError}` : "ok",
    true,
  );

  const memMeasurable = resources?.memAvailableMb !== null && resources?.memAvailableMb !== undefined;
  add(
    "memória disponível",
    !memMeasurable || resources.memAvailableMb >= t.memRequiredMb,
    memMeasurable
      ? `${resources.memAvailableMb} MB (exigido: ${t.memRequiredMb} MB)`
      : "indisponível",
    memMeasurable,
    memMeasurable ? resources.memAvailableMb : null,
    t.memRequiredMb,
  );

  const swapMeasurable = resources?.swapUsedMb !== null && resources?.swapUsedMb !== undefined;
  add(
    "swap em uso",
    !swapMeasurable || resources.swapUsedMb <= t.swapUsedMaxMb,
    swapMeasurable
      ? `${resources.swapUsedMb} MB (máximo: ${t.swapUsedMaxMb} MB)`
      : "indisponível",
    swapMeasurable,
    swapMeasurable ? resources.swapUsedMb : null,
    t.swapUsedMaxMb,
  );

  const loadMeasurable = resources?.load1 !== null && resources?.load1 !== undefined;
  add(
    "load average (1min)",
    !loadMeasurable || resources.load1 <= t.load1Max,
    loadMeasurable ? `${resources.load1} (máximo: ${t.load1Max})` : "indisponível",
    loadMeasurable,
    loadMeasurable ? resources.load1 : null,
    t.load1Max,
  );

  const diskMeasurable = resources?.diskAvailableGb !== null && resources?.diskAvailableGb !== undefined;
  add(
    "disco livre",
    !diskMeasurable || resources.diskAvailableGb >= t.diskFreeMinGb,
    diskMeasurable
      ? `${resources.diskAvailableGb} GB (mínimo: ${t.diskFreeMinGb} GB)`
      : "indisponível",
    diskMeasurable,
    diskMeasurable ? resources.diskAvailableGb : null,
    t.diskFreeMinGb,
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
 * Política de falha: TRANSIENT (pode esperar) vs HARD (aborta na hora).
 *
 * TRANSIENT - a pressão pode passar sozinha:
 *   - load average alto (típico: o próprio `npm ci` acabou de rodar);
 *   - swap um pouco acima do limite;
 *   - MemAvailable temporariamente abaixo do exigido.
 *
 * HARD - esperar não resolve (ou o risco é outro):
 *   - disco livre abaixo do mínimo (o build morre no meio de qualquer jeito);
 *   - erro de leitura de métrica essencial (não dá para decidir);
 *   - memória CRÍTICA (abaixo de CRITICAL_MEM_MB): o box está em risco.
 */
const CRITICAL_MEM_MB = 256;

function isHardFailure(check) {
  if (!check || check.ok) return false;
  if (check.name === "disco livre") return true;
  if (check.name === "leitura de recursos") return true;
  if (check.name === "memória disponível") {
    return typeof check.value === "number" && check.value < CRITICAL_MEM_MB;
  }
  return false;
}

/** Divide as falhas em hard (aborta) e transient (pode esperar). */
function classifyFailures(checks) {
  const hard = [];
  const transient = [];
  for (const check of checks ?? []) {
    if (check.ok) continue;
    if (isHardFailure(check)) hard.push(check);
    else transient.push(check);
  }
  return { hard, transient };
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

/** Config do cooldown (aguardar recursos antes de uma operação pesada). */
function readWaitConfig(env = process.env) {
  return {
    intervalSec: Math.max(1, Math.round(readNumber(env, "KORRELO_ROLLOUT_RESOURCE_WAIT_INTERVAL_SEC", 10))),
    timeoutSec: Math.max(0, Math.round(readNumber(env, "KORRELO_ROLLOUT_RESOURCE_WAIT_TIMEOUT_SEC", 180))),
  };
}

/**
 * Sleep padrão (sem busy loop).
 *
 * IMPORTANTE: o timer NÃO pode ser `unref()`.
 *
 * Durante o resource cooldown, o timer do sleep é o ÚNICO handle ativo do
 * rollout. Com `unref()`, o Node não mantém o event loop vivo, o processo
 * termina NORMALMENTE (exit code 0) e o cooldown nunca termina - o rollout
 * morre no meio, deixando o Git avançado, o PM2 na versão antiga e o
 * self-update.lock / worker-drain órfãos. Foi exatamente o que aconteceu
 * em produção: load1=3.54 > 1.5, o rollout imprimiu "aguardando recursos"
 * e voltou ao shell com exit code 0.
 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    // Sem unref: enquanto o cooldown dura, o processo do rollout fica vivo.
    setTimeout(resolve, ms);
  });
}

/** "load1=3.19 > 1.5" (números, sem conteúdo sensível). */
function formatCheckValue(check) {
  if (check.value === null || check.value === undefined) return `${check.name}: ${check.detail}`;
  return `${check.name}=${check.value} (limite ${check.limit})`;
}

/**
 * AGUARDA os recursos ficarem seguros antes de uma operação pesada.
 *
 * A pressão depois de um `npm ci` é TRANSITÓRIA: o load average ainda
 * reflete a carga recente. Abortar ali é um timeout evitável - o certo é
 * certo é esperar o host normalizar (sem busy loop) e só então compilar.
 *
 * Política:
 * - seguro             -> segue;
 * - falha TRANSIENT    -> espera `intervalSec` e mede de novo;
 * - falha HARD         -> aborta na hora (não adianta esperar);
 * - timeout            -> aborta (o chamador entra no recovery seguro).
 *
 * O tempo decorrido é VIRTUAL (soma dos intervalos): assim os testes são
 * determinísticos e não dormem de verdade.
 */
async function waitForSafeResources({
  readHost,
  thresholds,
  waitConfig,
  label = "rollout",
  sleep = defaultSleep,
  log = () => {},
} = {}) {
  const limits = thresholds ?? readThresholds();
  const wait = waitConfig ?? readWaitConfig();
  const attemptsAllowed = Math.max(1, Math.floor(wait.timeoutSec / Math.max(1, wait.intervalSec)) + 1);

  let attempt = 0;
  let elapsedSec = 0;
  let last = null;

  for (;;) {
    attempt += 1;
    const resources = await readHost();
    const evaluation = evaluateResources({ resources, thresholds: limits });
    last = { resources, evaluation };

    if (evaluation.safeToBuild) {
      if (attempt > 1) {
        log(
          `[rollout] ${label}: recursos normalizados após ${elapsedSec}s\n` +
            `${formatCheckValue({ name: "load1", value: resources.load1, limit: limits.load1Max })}`,
        );
      }
      return {
        ok: true,
        waited: attempt > 1,
        attempts: attempt,
        elapsedSec,
        resources,
        evaluation,
      };
    }

    const { hard, transient } = classifyFailures(evaluation.checks);

    if (hard.length > 0) {
      return {
        ok: false,
        hard: true,
        timeout: false,
        attempts: attempt,
        elapsedSec,
        resources,
        evaluation,
        hard,
        transient,
      };
    }

    if (attempt >= attemptsAllowed || elapsedSec + wait.intervalSec > wait.timeoutSec) {
      return {
        ok: false,
        hard: false,
        timeout: true,
        attempts: attempt,
        elapsedSec,
        resources,
        evaluation,
        hard,
        transient,
      };
    }

    log(
      `[rollout] ${label}: aguardando recursos\n` +
        `${transient.map((check) => formatCheckValue(check)).join("\n")}\n` +
        `tentativa=${attempt}\n` +
        `próxima checagem em ${wait.intervalSec}s`,
    );

    await sleep(wait.intervalSec * 1000);
    elapsedSec += wait.intervalSec;
  }
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
  CRITICAL_MEM_MB,
  realResourceProvider,
  readThresholds,
  readWaitConfig,
  parseMemInfo,
  parseDfOutput,
  readHostResources,
  evaluateResources,
  isHardFailure,
  classifyFailures,
  waitForSafeResources,
  defaultSleep,
  wrapBuildCommand,
  buildEnv,
};
