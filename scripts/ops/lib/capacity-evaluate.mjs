/**
 * Avaliação de capacidade do host para o rollout do Korrelo — funções PURAS.
 *
 * Entrada: um snapshot de métricas (coletado por `vps-capacity-audit.mjs` ou um
 * fixture). Saída: gates objetivos com GO/NO-GO separados para:
 *   - `coreUpdate`: atualizar o Korrelo mantendo o staging DESLIGADO;
 *   - `stagingActivation`: ligar `KORRELO_STAGING_ISOLATED_EXECUTION`.
 *
 * Nenhuma métrica ausente é tratada como "boa": vira gate reprovado.
 */

/** Orçamento do staging isolado validado em laboratório (RC1.4B/RC1.6B). */
export const STAGING_BUDGET = Object.freeze({
  appMemoryMb: 1024,
  mongoMemoryMb: 384, // 256 MB medido + margem (79% de uso no pico)
  overheadMb: 512,
  get totalMb() {
    return this.appMemoryMb + this.mongoMemoryMb + this.overheadMb;
  },
});

export const THRESHOLDS = Object.freeze({
  /** RAM disponível mínima (MemAvailable) para ligar o staging com produção rodando. */
  stagingAvailableMemoryMb: 2560,
  /** RAM disponível mínima só para atualizar o Core (processo único, sem staging). */
  coreAvailableMemoryMb: 1024,
  /** PSI memória `full avg10` aceitável em regime. */
  memoryPressureFull10: 1,
  /** Fração do nproc aceitável no load average de 5 min. */
  loadPerCpu: 0.6,
  /** Disco livre mínimo no filesystem que hospeda /var/lib/docker. */
  dockerDiskFreeGb: 10,
  /** Disco livre mínimo para atualizar o Core (imagens + logs). */
  coreDiskFreeGb: 3,
  /** Inodes livres mínimos e fração mínima do total. */
  freeInodes: 100_000,
  freeInodesFraction: 0.2,
  /** Eventos de OOM no kernel nas últimas 24h. */
  oomEvents24h: 0,
  /** Imagens extras (atual + rollback) que precisam caber além do uso atual. */
  imagesReserveGb: 1.5,
});

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function gate(id, ok, value, threshold, detail) {
  return { id, ok: Boolean(ok), value, threshold, detail };
}

function diskGate(prefix, disk, minFreeGb) {
  const freeGb = num(disk?.freeGb);
  const freeInodes = num(disk?.freeInodes);
  const totalInodes = num(disk?.totalInodes);
  return [
    gate(
      `${prefix}.diskFreeGb`,
      freeGb !== null && freeGb >= minFreeGb,
      freeGb,
      `>= ${minFreeGb}`,
      "espaço livre no filesystem do Docker",
    ),
    gate(
      `${prefix}.freeInodes`,
      freeInodes !== null &&
        freeInodes >= THRESHOLDS.freeInodes &&
        totalInodes !== null &&
        totalInodes > 0 &&
        freeInodes / totalInodes >= THRESHOLDS.freeInodesFraction,
      freeInodes,
      `>= ${THRESHOLDS.freeInodes} e >= ${Math.round(THRESHOLDS.freeInodesFraction * 100)}%`,
      "inodes livres",
    ),
  ];
}

/**
 * @param {object} snapshot
 * @param {{ staging?: {appMemoryMb:number, mongoMemoryMb:number, overheadMb:number} }} [options]
 */
export function evaluateCapacity(snapshot, options = {}) {
  const budget = { ...STAGING_BUDGET, ...(options.staging ?? {}) };
  const requiredMb = budget.appMemoryMb + budget.mongoMemoryMb + budget.overheadMb;

  const host = snapshot?.host ?? {};
  const memory = snapshot?.memory ?? {};
  const docker = snapshot?.docker ?? {};
  const disk = snapshot?.dockerDisk ?? snapshot?.disk?.docker ?? {};
  const rootDisk = snapshot?.disk?.root ?? disk;
  const oom = snapshot?.oom ?? {};
  const psi = snapshot?.psi ?? {};

  const nproc = num(host.nproc);
  const load5 = Array.isArray(host.loadavg) ? num(host.loadavg[1]) : null;
  const memAvailableMb = num(memory.availableMb);
  const memFull10 = num(psi.memory?.full10 ?? psi.memoryFull10);
  const oomEvents = num(oom.events24h);

  const containers = Array.isArray(docker.containers) ? docker.containers : [];
  const oomContainers = containers.filter((c) => c?.oomKilled === true);
  const unhealthy = containers.filter((c) => c?.health && c.health !== "healthy" && c.health !== "none");

  const commonDocker = [
    gate("docker.reachable", docker.reachable === true, docker.reachable ?? null, "true", "Docker respondeu à leitura"),
    gate("docker.oomContainers", oomContainers.length === 0, oomContainers.map((c) => c.name), "0", "containers com OOMKilled=true"),
    gate("docker.unhealthyContainers", unhealthy.length === 0, unhealthy.map((c) => `${c.name}:${c.health}`), "0", "containers unhealthy"),
  ];

  const oomGate = gate(
    "kernel.oomEvents24h",
    oomEvents !== null && oomEvents <= THRESHOLDS.oomEvents24h,
    oomEvents,
    `<= ${THRESHOLDS.oomEvents24h}`,
    "eventos de OOM no kernel nas últimas 24h",
  );

  const coreChecks = [
    ...commonDocker,
    oomGate,
    gate(
      "core.memAvailableMb",
      memAvailableMb !== null && memAvailableMb >= THRESHOLDS.coreAvailableMemoryMb,
      memAvailableMb,
      `>= ${THRESHOLDS.coreAvailableMemoryMb}`,
      "RAM disponível para reiniciar o Core",
    ),
    ...diskGate("core", rootDisk, THRESHOLDS.coreDiskFreeGb),
  ];

  const stagingChecks = [
    ...commonDocker,
    oomGate,
    gate(
      "staging.memAvailableMb",
      memAvailableMb !== null && memAvailableMb >= THRESHOLDS.stagingAvailableMemoryMb,
      memAvailableMb,
      `>= ${THRESHOLDS.stagingAvailableMemoryMb}`,
      "RAM disponível com produção rodando",
    ),
    gate(
      "staging.projectedMarginMb",
      memAvailableMb !== null && memAvailableMb - requiredMb >= 0,
      memAvailableMb === null ? null : memAvailableMb - requiredMb,
      `>= 0 (disponível - ${requiredMb})`,
      "margem após reservar app+Mongo+overhead",
    ),
    gate(
      "staging.memoryPressureFull10",
      memFull10 !== null && memFull10 <= THRESHOLDS.memoryPressureFull10,
      memFull10,
      `<= ${THRESHOLDS.memoryPressureFull10}`,
      "PSI memória full avg10 (%)",
    ),
    gate(
      "staging.loadPerCpu",
      nproc !== null && load5 !== null && nproc > 0 && load5 / nproc <= THRESHOLDS.loadPerCpu,
      nproc !== null && load5 !== null ? Number((load5 / nproc).toFixed(2)) : null,
      `<= ${THRESHOLDS.loadPerCpu}`,
      "load average (5 min) por CPU",
    ),
    gate(
      "staging.swapFreeMb",
      num(memory.swapTotalMb) === null || num(memory.swapTotalMb) === 0 || (num(memory.swapFreeMb) ?? 0) > 0,
      memory.swapFreeMb ?? null,
      "> 0 quando existe swap",
      "swap livre (swap cheio = pressão real)",
    ),
    ...diskGate("staging", disk, THRESHOLDS.dockerDiskFreeGb),
    gate(
      "staging.imagesReserveGb",
      num(disk.freeGb) !== null && num(disk.freeGb) >= THRESHOLDS.dockerDiskFreeGb + THRESHOLDS.imagesReserveGb,
      num(disk.freeGb) === null ? null : Number((num(disk.freeGb) - THRESHOLDS.imagesReserveGb).toFixed(2)),
      `>= ${THRESHOLDS.dockerDiskFreeGb + THRESHOLDS.imagesReserveGb} livres (inclui ${THRESHOLDS.imagesReserveGb} para atual+rollback)`,
      "disco para as duas imagens do Mesatta",
    ),
  ];

  const summarize = (checks) => {
    const failed = checks.filter((c) => !c.ok);
    return {
      verdict: failed.length === 0 ? "GO" : "NO-GO",
      failed: failed.map((c) => c.id),
      checks,
    };
  };

  return {
    evaluatedAt: new Date().toISOString(),
    budget: { ...budget, requiredMb },
    availableMemoryMb: memAvailableMb,
    marginMb: memAvailableMb === null ? null : memAvailableMb - requiredMb,
    coreUpdate: summarize(coreChecks),
    stagingActivation: summarize(stagingChecks),
  };
}
