/**
 * SMART DEPLOY V2 — PLANEJADOR PURO (somente decisão).
 *
 * Problema que este módulo resolve: o preflight atual soma a reserva do
 * staging ao requisito do build, embora build e staging sejam sequenciais.
 * Em VPS de 4 GB isso cria uma exigência artificial de ~768 MB e bloqueia
 * deploys por dezenas de MB.
 *
 * O planejador modela FASES EXPLÍCITAS:
 *   build → staging → promoção
 * e exige, para cada fase, o maior entre o headroom da produção e o pico da
 * fase (mesmo operador conservador já usado hoje), SEM somar fases que não
 * acontecem ao mesmo tempo.
 *
 * Regras invioláveis:
 *  - commit precisa estar fixado; nunca usar HEAD implícito;
 *  - imagem pré-construída só vale com digest/labels do commit verificados;
 *  - sem perfil medido, usa a estimativa conservadora existente;
 *  - PSI/swap/load/disk ruins => esperar ou recusar, nunca "forçar";
 *  - nada aqui altera margens, fila, preflight ou executa Docker.
 */

export const SMART_DEPLOY_SAFETY_MARGIN_MB = 256;
export const SMART_DEPLOY_HOST_FLOOR_MB = 1_200;
export const SMART_DEPLOY_BUILD_ESTIMATE_MB = 1_024;
export const SMART_DEPLOY_DISK_BUILD_MB = 9_216;
export const SMART_DEPLOY_DISK_PREBUILT_MB = 1_024;
export const SMART_DEPLOY_WAIT_BASE_MS = 60_000;

export type SmartDeployStrategy =
  | "local-build"
  | "local-build-sequential"
  | "prebuilt-image"
  | "wait"
  | "insufficient";

export type SmartDeployAction = "proceed" | "wait" | "refuse";

export type EvidenceKind = "measured" | "estimate" | "policy";

export interface ProfileEvidence {
  valid: boolean;
  peakMb: number | null;
  confidence: "low" | "medium" | "high" | "none";
  measuredAt?: string | null;
}

export interface SmartDeployHost {
  totalMemMb: number | null;
  memAvailableMb: number | null;
  swapTotalMb: number | null;
  swapFreeMb: number | null;
  diskFreeMb: number | null;
  load1: number | null;
  psiSome10: number | null;
  psiFull10: number | null;
}

export interface SmartDeployProduction {
  running: boolean;
  /** Limite observado/registrado do container. */
  limitMb: number | null;
  /** Consumo atual (docker stats). null = desconhecido. */
  usageMb: number | null;
}

export interface SmartDeployHistory {
  samples: number;
  confidence: "none" | "low" | "medium" | "high";
  sampledPeakMb: number | null;
  cgroupPeakMb: number | null;
}

export interface SmartDeployQueue {
  runningDeploy: boolean;
  queuedDeploys: number;
  activeBuilds: number;
  selfUpdateRunning: boolean;
  workerDraining: boolean;
  /** Tentativas de recurso já consumidas (0 na primeira). */
  attemptsUsed: number;
  maxAttempts: number;
}

export interface SmartDeployImages {
  /** Tag do commit existe no host. */
  exactCommitImageExists: boolean;
  /** Digest/labels conferem com o commit/projeto (nunca presumir pela tag). */
  imageDigestVerified: boolean;
  /** Essa imagem já passou por staging/health em execução anterior. */
  prebuiltStagingValidated: boolean;
}

export interface SmartDeployRequirements {
  requiresStaging: boolean;
  requiresZeroDowntime: boolean;
  productionMustKeepRunning: boolean;
  skipStagingConfigured: boolean;
}

export interface SmartDeployCapabilities {
  /**
   * O orquestrador consegue rodar build e staging em passos separados, com
   * reavaliação de recursos entre eles. Sem isso, a estratégia sequencial
   * NÃO pode ser prometida.
   */
  phaseBoundaryRecheck: boolean;
  /** O orquestrador sabe promover uma imagem local já verificada. */
  prebuiltPromotion: boolean;
}

export interface SmartDeployLastAttempt {
  promotionFailed: boolean;
  rollbackConfirmed: boolean;
}

export interface SmartDeployInput {
  commit: {
    requestedSha: string | null;
    /** HEAD atual da branch (informativo; não substitui o commit fixado). */
    branchHeadSha?: string | null;
  };
  host: SmartDeployHost;
  production: SmartDeployProduction;
  history: SmartDeployHistory;
  profiles: {
    build: ProfileEvidence | null;
    staging: ProfileEvidence | null;
  };
  estimates?: {
    buildMb?: number;
    stagingMb?: number | null;
    safetyMarginMb?: number;
    hostFloorMb?: number;
    diskBuildMb?: number;
    diskPrebuiltMb?: number;
  };
  queue: SmartDeployQueue;
  images: SmartDeployImages;
  requirements: SmartDeployRequirements;
  capabilities: SmartDeployCapabilities;
  thresholds?: {
    load1Max?: number;
    psiSomeMax?: number;
    psiFullMax?: number;
    swapFreeMinMb?: number;
  };
  lastAttempt?: SmartDeployLastAttempt | null;
}

export interface SmartDeployPhase {
  name: "build" | "staging" | "promotion";
  requiredMb: number;
  evidence: EvidenceKind;
  concurrentWithProduction: boolean;
  note: string;
}

export interface ShadowComparison {
  conservativeRequiredMb: number | null;
  plannerRequiredMb: number | null;
  savingMb: number | null;
  /** true quando o planejador exigiria MAIS que a política atual. */
  moreConservative: boolean;
  note: string;
}

export interface SmartDeployDecision {
  strategy: SmartDeployStrategy;
  action: SmartDeployAction;
  commitSha: string | null;
  requiredMb: number | null;
  availableMb: number | null;
  shortfallMb: number;
  phases: SmartDeployPhase[];
  reasons: string[];
  evidence: string[];
  unmeasuredRisks: string[];
  nextRecheckMs: number | null;
  comparison: ShadowComparison;
}

const COMMIT_RE = /^[a-f0-9]{40}$/;

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function nonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function withFloor(base: number, floor: number): number {
  return Math.max(floor, base);
}

/** Mesmo operador conservador de hoje, aplicado a UMA fase. */
function phaseRequiredMb(headroomMb: number, peakMb: number, safetyMb: number, floorMb: number): number {
  return withFloor(Math.max(headroomMb, peakMb) + safetyMb, floorMb);
}

function profilePeak(
  profile: ProfileEvidence | null,
  fallbackMb: number,
): { peakMb: number; evidence: EvidenceKind; risk: string | null } {
  if (profile?.valid && positive(profile.peakMb) !== null) {
    return {
      peakMb: profile.peakMb as number,
      evidence: "measured",
      risk: profile.confidence === "low" ? "perfil medido com confiança baixa" : null,
    };
  }
  return {
    peakMb: fallbackMb,
    evidence: "estimate",
    risk: "sem perfil medido válido; usando estimativa conservadora",
  };
}

function hostBlockers(input: SmartDeployInput, thresholds: Required<NonNullable<SmartDeployInput["thresholds"]>>): string[] {
  const host = input.host;
  const reasons: string[] = [];
  if (positive(host.memAvailableMb) === null) reasons.push("MemAvailable não pôde ser lido");
  if (positive(host.diskFreeMb) === null) reasons.push("disco livre não pôde ser lido");
  if (host.load1 !== null && host.load1 > thresholds.load1Max) {
    reasons.push(`load1 ${host.load1.toFixed(2)} acima de ${thresholds.load1Max}`);
  }
  if (host.psiSome10 !== null && host.psiSome10 > thresholds.psiSomeMax) {
    reasons.push(`PSI some ${host.psiSome10.toFixed(2)} acima de ${thresholds.psiSomeMax}`);
  }
  if (host.psiFull10 !== null && host.psiFull10 > thresholds.psiFullMax) {
    reasons.push(`PSI full ${host.psiFull10.toFixed(3)} acima de ${thresholds.psiFullMax}`);
  }
  if (
    host.swapTotalMb !== null &&
    host.swapTotalMb > 0 &&
    host.swapFreeMb !== null &&
    host.swapFreeMb < thresholds.swapFreeMinMb
  ) {
    reasons.push(`swap livre ${host.swapFreeMb} MB abaixo de ${thresholds.swapFreeMinMb} MB`);
  }
  return reasons;
}

/**
 * Decide a estratégia. PURO: nenhum I/O.
 */
export function planSmartDeploy(input: SmartDeployInput): SmartDeployDecision {
  const estimates = input.estimates ?? {};
  const safetyMb = positive(estimates.safetyMarginMb) ?? SMART_DEPLOY_SAFETY_MARGIN_MB;
  const floorMb = positive(estimates.hostFloorMb) ?? SMART_DEPLOY_HOST_FLOOR_MB;
  const buildEstimateMb = positive(estimates.buildMb) ?? SMART_DEPLOY_BUILD_ESTIMATE_MB;
  const stagingEstimateMb =
    estimates.stagingMb === null
      ? buildEstimateMb
      : positive(estimates.stagingMb) ?? positive(input.production.limitMb) ?? buildEstimateMb;
  const diskBuildMb = positive(estimates.diskBuildMb) ?? SMART_DEPLOY_DISK_BUILD_MB;
  const diskPrebuiltMb = positive(estimates.diskPrebuiltMb) ?? SMART_DEPLOY_DISK_PREBUILT_MB;
  const thresholds = {
    load1Max: input.thresholds?.load1Max ?? 1.5,
    psiSomeMax: input.thresholds?.psiSomeMax ?? 1,
    psiFullMax: input.thresholds?.psiFullMax ?? 0.01,
    swapFreeMinMb: input.thresholds?.swapFreeMinMb ?? 256,
  };

  const reasons: string[] = [];
  const evidence: string[] = [];
  const unmeasuredRisks: string[] = [];

  const requested = (input.commit.requestedSha ?? "").trim().toLowerCase();
  const commitPinned = COMMIT_RE.test(requested);
  const commitSha = commitPinned ? requested : null;
  if (!commitPinned) {
    reasons.push("commit não está fixado (SHA completo é obrigatório antes de planejar)");
  } else {
    evidence.push(`commit fixado: ${requested.slice(0, 12)}`);
    if (input.commit.branchHeadSha && input.commit.branchHeadSha.toLowerCase() !== requested) {
      reasons.push("HEAD da branch difere do commit fixado; o job deve usar o SHA fixado, nunca o HEAD");
    }
  }

  const historyPeak = positive(input.history.cgroupPeakMb) ?? positive(input.history.sampledPeakMb);
  if (historyPeak !== null) {
    evidence.push(
      `histórico do container: ${input.history.samples} amostras, confiança ${input.history.confidence}, pico ${historyPeak} MB`,
    );
  }
  if (input.history.confidence === "none" || input.history.confidence === "low") {
    unmeasuredRisks.push("histórico de produção com confiança baixa/ausente");
  }

  // Headroom da produção: MemAvailable já desconta o consumo ATUAL; só o
  // crescimento possível precisa continuar livre.
  let headroomMb: number | null = null;
  if (!input.production.running) {
    headroomMb = 0;
    evidence.push("projeto não está rodando; sem headroom de produção");
  } else {
    const limit = positive(input.production.limitMb);
    const usage = nonNegative(input.production.usageMb);
    if (limit === null) {
      reasons.push("limite de produção desconhecido");
    } else if (usage === null) {
      headroomMb = limit;
      unmeasuredRisks.push("consumo atual da produção desconhecido; headroom = limite inteiro");
      evidence.push("headroom conservador = limite inteiro (consumo desconhecido)");
    } else {
      headroomMb = Math.max(0, limit - usage);
      evidence.push(`headroom de produção = ${headroomMb} MB (limite ${limit} - uso ${usage})`);
    }
  }

  const build = profilePeak(input.profiles.build, buildEstimateMb);
  const staging = profilePeak(input.profiles.staging, stagingEstimateMb);
  if (build.risk) unmeasuredRisks.push(`build: ${build.risk}`);
  if (staging.risk) unmeasuredRisks.push(`staging: ${staging.risk}`);

  const diskRequiredBuild = diskBuildMb;
  const diskRequiredPrebuilt = diskPrebuiltMb;
  const diskFree = positive(input.host.diskFreeMb);

  // Imagem pré-construída só é candidata com identidade verificada.
  const prebuiltUsable =
    input.images.exactCommitImageExists &&
    input.images.imageDigestVerified &&
    input.capabilities.prebuiltPromotion;
  const prebuiltCanSkipBuild = prebuiltUsable;
  const stagingConfigured =
    input.requirements.requiresStaging && !input.requirements.skipStagingConfigured;
  const stagingValidated = input.images.prebuiltStagingValidated && prebuiltUsable;
  const stagingRequiredForLocal = stagingConfigured;
  const stagingRequiredForPrebuilt = stagingConfigured && !stagingValidated;

  if (input.host.swapTotalMb === 0) {
    unmeasuredRisks.push("host sem swap: picos podem causar OOM em vez de apenas lentidão");
  }

  const buildPhasePeak = build.peakMb;
  const stagingPhasePeak = staging.peakMb;

  const buildPhase = (headroom: number): SmartDeployPhase => ({
    name: "build",
    requiredMb: phaseRequiredMb(headroom, buildPhasePeak, safetyMb, floorMb),
    evidence: build.evidence,
    concurrentWithProduction: input.production.running,
    note:
      build.evidence === "measured"
        ? "pico de build medido"
        : "estimativa conservadora de build (sem perfil medido)",
  });
  const stagingPhase = (headroom: number): SmartDeployPhase => ({
    name: "staging",
    requiredMb: phaseRequiredMb(headroom, stagingPhasePeak, safetyMb, floorMb),
    evidence: staging.evidence,
    concurrentWithProduction: input.production.running,
    note:
      staging.evidence === "measured"
        ? "pico de staging medido"
        : "estimativa conservadora de staging (sem perfil medido)",
  });
  const promotionPhase = (headroom: number): SmartDeployPhase => {
    const productionLimit = positive(input.production.limitMb) ?? stagingPhasePeak;
    return {
      name: "promotion",
      requiredMb: phaseRequiredMb(headroom, productionLimit, safetyMb, floorMb),
      evidence: input.requirements.requiresZeroDowntime ? "policy" : "estimate",
      concurrentWithProduction: input.requirements.requiresZeroDowntime,
      note: input.requirements.requiresZeroDowntime
        ? "promoção exige convivência temporária com a produção"
        : "promoção recria o container (o antigo não fica servindo)",
    };
  };

  // Estratégia sequencial (B): build, staging e promoção são fases separadas.
  // O requisito é o MAIOR entre elas, não a soma.
  const sequentialPhases: SmartDeployPhase[] = [];
  if (headroomMb !== null) {
    if (!prebuiltCanSkipBuild) sequentialPhases.push(buildPhase(headroomMb));
    if (stagingRequiredForLocal) sequentialPhases.push(stagingPhase(headroomMb));
    sequentialPhases.push(promotionPhase(headroomMb));
  }
  const sequentialRequired = sequentialPhases.length
    ? Math.max(...sequentialPhases.map((phase) => phase.requiredMb))
    : null;

  // Estratégia A (comando único atual): staging é somado ao build porque o
  // orquestrador não prova a separação. Mantém a política conservadora.
  const conservativeRequired =
    headroomMb === null
      ? null
      : withFloor(
          Math.max(headroomMb, buildPhasePeak) +
            safetyMb +
            (stagingRequiredForLocal ? stagingPhasePeak : 0),
          floorMb,
        );

  // Estratégia C: imagem do commit já verificada. Sem build; staging só se
  // ainda não houver validação.
  const prebuiltPhases: SmartDeployPhase[] = [];
  if (headroomMb !== null) {
    if (stagingRequiredForPrebuilt) prebuiltPhases.push(stagingPhase(headroomMb));
    prebuiltPhases.push(promotionPhase(headroomMb));
  }
  const prebuiltRequired = prebuiltPhases.length
    ? Math.max(...prebuiltPhases.map((phase) => phase.requiredMb))
    : null;

  const availableMb = positive(input.host.memAvailableMb);
  const queueBlockers: string[] = [];
  if (input.queue.selfUpdateRunning) queueBlockers.push("self-update do Korrelo em andamento");
  if (input.queue.workerDraining) queueBlockers.push("worker de deploy em manutenção");
  if (input.queue.runningDeploy || input.queue.activeBuilds > 0) {
    queueBlockers.push("já existe deploy/build em andamento (execução é serial)");
  }
  const hostReasons = hostBlockers(input, thresholds);
  const attemptsExhausted =
    input.queue.attemptsUsed >= Math.max(1, input.queue.maxAttempts);
  const promotionUnsafe =
    input.lastAttempt?.promotionFailed === true && input.lastAttempt.rollbackConfirmed !== true;

  const comparisonFor = (plannerRequired: number | null): ShadowComparison => {
    if (conservativeRequired === null || plannerRequired === null) {
      return {
        conservativeRequiredMb: conservativeRequired,
        plannerRequiredMb: plannerRequired,
        savingMb: null,
        moreConservative: false,
        note: "comparação indisponível (dados insuficientes)",
      };
    }
    const saving = conservativeRequired - plannerRequired;
    return {
      conservativeRequiredMb: conservativeRequired,
      plannerRequiredMb: plannerRequired,
      savingMb: saving,
      moreConservative: saving < 0,
      note:
        saving >= 0
          ? `planejador exigiria ${saving} MB a menos que a política atual`
          : `planejador exigiria ${Math.abs(saving)} MB a MAIS que a política atual`,
    };
  };

  const refuse = (
    strategy: SmartDeployStrategy,
    why: string[],
    comparison = comparisonFor(null),
  ): SmartDeployDecision => ({
    strategy,
    action: "refuse",
    commitSha,
    requiredMb: null,
    availableMb,
    shortfallMb: 0,
    phases: [],
    reasons: [...reasons, ...why],
    evidence,
    unmeasuredRisks,
    nextRecheckMs: null,
    comparison,
  });

  const wait = (
    why: string[],
    candidatePhases: SmartDeployPhase[],
    candidateRequired: number | null,
    nextRecheckMs = Math.min(
      300_000,
      SMART_DEPLOY_WAIT_BASE_MS * Math.max(1, input.queue.attemptsUsed + 1),
    ),
  ): SmartDeployDecision => ({
    strategy: "wait",
    action: "wait",
    commitSha,
    requiredMb: candidateRequired,
    availableMb,
    shortfallMb:
      candidateRequired !== null && availableMb !== null
        ? Math.max(0, candidateRequired - availableMb)
        : 0,
    phases: candidatePhases,
    reasons: [...reasons, ...why],
    evidence,
    unmeasuredRisks,
    nextRecheckMs,
    comparison: comparisonFor(candidateRequired),
  });

  if (!commitPinned) {
    return refuse("insufficient", ["fixe o commit SHA completo antes do deploy"]);
  }
  if (promotionUnsafe) {
    return refuse("insufficient", [
      "promoção anterior falhou e o rollback não foi confirmado; reconcilie antes de novo deploy",
    ]);
  }
  if (queueBlockers.length > 0) {
    return wait(queueBlockers, sequentialPhases, sequentialRequired);
  }
  if (headroomMb === null) {
    return wait(reasons.filter((reason) => reason.includes("limite")), sequentialPhases, sequentialRequired);
  }
  if (availableMb === null) {
    return wait(["MemAvailable indisponível; não é seguro decidir"], sequentialPhases, sequentialRequired);
  }
  if (hostReasons.length > 0) {
    return wait(hostReasons, sequentialPhases, sequentialRequired);
  }
  if (input.host.totalMemMb !== null && input.host.totalMemMb < floorMb) {
    return refuse("insufficient", [
      `host tem ${input.host.totalMemMb} MB no total, abaixo do piso de segurança de ${floorMb} MB`,
    ]);
  }

  // Disco: pré-construída exige menos; build exige o orçamento completo.
  const prebuiltFitsDisk = diskFree !== null && diskFree >= diskRequiredPrebuilt;
  const buildFitsDisk = diskFree !== null && diskFree >= diskRequiredBuild;

  const candidates: Array<{
    strategy: SmartDeployStrategy;
    phases: SmartDeployPhase[];
    required: number;
    diskOk: boolean;
  }> = [];
  if (prebuiltUsable && prebuiltRequired !== null) {
    candidates.push({
      strategy: "prebuilt-image",
      phases: prebuiltPhases,
      required: prebuiltRequired,
      diskOk: prebuiltFitsDisk,
    });
  }
  if (input.capabilities.phaseBoundaryRecheck && sequentialRequired !== null) {
    candidates.push({
      strategy: "local-build-sequential",
      phases: sequentialPhases,
      required: sequentialRequired,
      diskOk: buildFitsDisk,
    });
  }
  if (conservativeRequired !== null) {
    candidates.push({
      strategy: "local-build",
      phases: headroomMb === null ? [] : [buildPhase(headroomMb), ...(stagingRequiredForLocal ? [stagingPhase(headroomMb)] : []), promotionPhase(headroomMb)],
      required: conservativeRequired,
      diskOk: buildFitsDisk,
    });
  }

  const feasible = candidates
    .filter((candidate) => candidate.diskOk && candidate.required <= availableMb)
    .sort((a, b) => a.required - b.required)[0];

  if (feasible) {
    reasons.push(
      feasible.strategy === "prebuilt-image"
        ? "imagem do commit já construída e verificada; build local dispensável"
        : feasible.strategy === "local-build-sequential"
          ? "build e staging são executados em fases separadas, com reavaliação entre elas"
          : "build e staging no mesmo comando, com a reserva conservadora atual",
    );
    if (feasible.strategy === "local-build-sequential") {
      reasons.push("a reserva do staging não é somada ao build porque não são simultâneos");
    }
    return {
      strategy: feasible.strategy,
      action: "proceed",
      commitSha,
      requiredMb: feasible.required,
      availableMb,
      shortfallMb: 0,
      phases: feasible.phases,
      reasons,
      evidence,
      unmeasuredRisks,
      nextRecheckMs: null,
      comparison: comparisonFor(feasible.required),
    };
  }

  // Nenhuma candidata cabe. Distinguir "esperar" de "fisicamente inviável".
  const best = candidates.sort((a, b) => a.required - b.required)[0] ?? null;
  const physicalImpossible =
    best !== null &&
    ((input.host.totalMemMb !== null && best.required > input.host.totalMemMb) ||
      (diskFree !== null && diskFree < Math.min(diskRequiredBuild, diskRequiredPrebuilt)));

  if (physicalImpossible || attemptsExhausted) {
    return refuse(
      "insufficient",
      [
        attemptsExhausted
          ? `tentativas de recurso esgotadas (${input.queue.attemptsUsed}/${input.queue.maxAttempts})`
          : "nenhuma estratégia cabe fisicamente neste host",
        best ? `melhor requisito calculado: ${best.required} MB; disponível: ${availableMb} MB` : "requisito não calculável",
      ],
      comparisonFor(best?.required ?? null),
    );
  }

  const shortfall = best ? Math.max(0, best.required - availableMb) : null;
  return wait(
    [
      shortfall !== null
        ? `faltam ${shortfall} MB para a melhor estratégia segura (${best?.strategy})`
        : "nenhuma estratégia segura disponível no momento",
      "a produção continua intocada; a fila reavalia sem reiniciar indefinidamente",
    ],
    best?.phases ?? sequentialPhases,
    best?.required ?? sequentialRequired,
  );
}

/**
 * Comparação em SOMBRA: roda o planejador contra os mesmos dados e devolve
 * apenas a diferença em relação à política conservadora. Não decide nada.
 */
export function compareSmartDeployShadow(input: SmartDeployInput): {
  decision: SmartDeployDecision;
  comparison: ShadowComparison;
} {
  const decision = planSmartDeploy(input);
  return { decision, comparison: decision.comparison };
}
