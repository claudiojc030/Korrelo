/**
 * LABORATÓRIO DE MEDIÇÃO DE BUILD/STAGING (Resource Manager V1 — Fase C.3b).
 *
 * Este módulo NÃO executa Docker. Ele decide, de forma pura e testável:
 *  - se o host tem recursos para a medição;
 *  - quais nomes/limites/estimativas a execução usará;
 *  - como classificar o resultado de um build ou staging;
 *  - como montar um `ResourceProfile` compatível com a Fase C.3a;
 *  - quais recursos PODEM ser removidos ao final (nunca prune genérico).
 *
 * O build real roda apenas pelo `scripts/lab/measure-project-profile.sh`, sob
 * autorização explícita. Nada aqui altera preflight, fila, margens ou deploy.
 */

import { createHash } from "node:crypto";
import {
  RESOURCE_PROFILE_SCHEMA_VERSION,
  deriveProfileConfidence,
  isImageDigest,
  isSha256,
  type BuildMeasurement,
  type ProfileEnvironment,
  type ResourceProfile,
  type StagingMeasurement,
} from "./resource-profile";

export type LabCacheState = "cold" | "warm" | "unknown";

export type LabOutcome =
  | "success"
  | "oom"
  | "external-failure"
  | "timeout"
  | "collection-failure"
  | "incomplete";

export interface LabLimits {
  buildMemoryMb: number;
  buildSwapMb: number;
  buildCpus: number;
  stagingMemoryMb: number;
  stagingSwapMb: number;
  stagingCpus: number;
  mongoMemoryMb: number;
}

export interface LabHostCapacity {
  /** MemAvailable medido no host (MB). */
  memAvailableMb: number | null;
  /** Disco livre no filesystem do Docker (MB). */
  diskFreeMb: number | null;
  cpuCount: number | null;
  cgroupVersion: 1 | 2 | null;
  arch: string | null;
  dockerVersion?: string | null;
  /** RAM total do host de laboratório (MB), quando conhecida. */
  totalMemMb?: number | null;
}

export interface LabTargetEnvironment {
  arch: string | null;
  cgroupVersion: 1 | 2 | null;
  dockerVersion: string | null;
  /** RAM total da VPS de destino (MB), quando conhecida. */
  totalMemMb?: number | null;
}

export interface LabRunRequest {
  runId: string;
  projectId: string;
  commitSha: string;
  dockerfileSha256: string;
  lockfileSha256: string | null;
  baseImageId: string | null;
  cacheState: LabCacheState;
  dockerVersion: string | null;
  buildkitVersion: string | null;
  arch: string | null;
  host: LabHostCapacity;
  target: LabTargetEnvironment;
  limits: LabLimits;
  /** Execuções de laboratório ainda ativas (locks). */
  existingRunIds?: string[];
}

export interface LabDiskEstimate {
  baseImageMb: number;
  buildCacheMb: number;
  imageExportMb: number;
  reserveMb: number;
  totalMb: number;
}

export interface LabRunResources {
  builderName: string;
  builderContainerName: string;
  imageTag: string;
  stagingContainerName: string;
  mongoContainerName: string;
  networkName: string;
  anonymousVolumesAllowed: false;
}

export interface LabRunPlan {
  runId: string;
  projectSlug: string;
  resources: LabRunResources;
  limits: LabLimits;
  diskEstimate: LabDiskEstimate;
  cacheState: LabCacheState;
  /** Sempre true: relatórios de laboratório não reduzem reserva nesta fase. */
  readOnlyEvidence: true;
}

export interface LabPlanIssue {
  code:
    | "LAB_RUN_ID_INVALID"
    | "LAB_RUN_CONCURRENT"
    | "LAB_INPUT_INVALID"
    | "LAB_HOST_MEMORY"
    | "LAB_HOST_DISK"
    | "LAB_HOST_CPU"
    | "LAB_TARGET_UNKNOWN";
  message: string;
}

export interface LabPlanResult {
  ok: boolean;
  issues: LabPlanIssue[];
  plan: LabRunPlan | null;
}

export interface LabRawResult {
  exitCode: number | null;
  timedOut: boolean;
  oomKilled: boolean;
  oomEvents: number | null;
  /** Pico em MB: cgroup `memory.peak` ou maior amostra de `memory.current`. */
  peakMb: number | null;
  peakSource: "cgroup-peak" | "sampled" | null;
  samples: number;
  samplingComplete: boolean;
  durationMs: number | null;
  pressureSomePeak?: number | null;
  pressureFullPeak?: number | null;
  logTail?: string | null;
  errorMessage?: string | null;
  healthOk?: boolean;
}

export interface LabMeasurementMetadata {
  dockerVersion: string | null;
  buildkitVersion: string | null;
  arch: string | null;
  cacheState: LabCacheState;
  baseImageId: string | null;
  imageDigest: string | null;
  host: LabHostCapacity;
  target: LabTargetEnvironment;
  buildOutcome: LabOutcome;
  stagingOutcome: LabOutcome;
  inputsFingerprint: string;
  targetMatches: boolean;
  targetMismatchReasons: string[];
  exclusive: boolean;
  /** Nesta fase é SEMPRE false: perfil não autoriza reduzir reservas. */
  allowedForReservationReduction: false;
  notes: string[];
}

export interface LabResourceProfile extends ResourceProfile {
  lab: LabMeasurementMetadata;
}

const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{5,48}$/;
const DEFAULT_BASE_IMAGE_MB = 2_048;
const DEFAULT_BUILD_CACHE_MB = 4_096;
const DEFAULT_IMAGE_EXPORT_MB = 1_024;
const DEFAULT_DISK_RESERVE_MB = 4_096;
const DEFAULT_HOST_MEMORY_RESERVE_MB = 1_024;

const EXTERNAL_FAILURE_PATTERNS = [
  /etimedout/i,
  /econnreset/i,
  /econnrefused/i,
  /enotfound/i,
  /eai_again/i,
  /no such host/i,
  /could not resolve/i,
  /tls handshake timeout/i,
  /failed to fetch/i,
  /failed to download/i,
  /registry.*(?:unavailable|timeout)/i,
  /network is unreachable/i,
  /\b(?:429|502|503|504)\b/,
];

const OOM_PATTERNS = [
  /out of memory/i,
  /cannot allocate memory/i,
  /\benomem\b/i,
  /killed\s*$/im,
  /signal:\s*killed/i,
  /exit code:\s*137/i,
];

function canonicalize(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalize(entry));
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry === undefined) continue;
      output[key] = normalize(entry);
    }
    return output;
  }
  return value;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function sanitizeSlug(value: string, maxLength: number): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
}

export function estimateLabDiskMb(overrides: Partial<LabDiskEstimate> = {}): LabDiskEstimate {
  const baseImageMb = positiveInteger(overrides.baseImageMb) ? overrides.baseImageMb : DEFAULT_BASE_IMAGE_MB;
  const buildCacheMb = positiveInteger(overrides.buildCacheMb) ? overrides.buildCacheMb : DEFAULT_BUILD_CACHE_MB;
  const imageExportMb = positiveInteger(overrides.imageExportMb) ? overrides.imageExportMb : DEFAULT_IMAGE_EXPORT_MB;
  const reserveMb = positiveInteger(overrides.reserveMb) ? overrides.reserveMb : DEFAULT_DISK_RESERVE_MB;
  return {
    baseImageMb,
    buildCacheMb,
    imageExportMb,
    reserveMb,
    totalMb: baseImageMb + buildCacheMb + imageExportMb + reserveMb,
  };
}

/**
 * Fingerprint dos INSUMOS, calculado ANTES do build.
 *
 * Não inclui o digest da imagem construída (conhecido só depois) nem o próprio
 * fingerprint — não há ciclo. O digest entra no fingerprint do perfil final.
 */
export function computeLabInputsFingerprint(request: LabRunRequest): string {
  const inputs = {
    projectId: request.projectId,
    commitSha: request.commitSha,
    dockerfileSha256: request.dockerfileSha256,
    lockfileSha256: request.lockfileSha256,
    baseImageId: request.baseImageId,
    cacheState: request.cacheState,
    dockerVersion: request.dockerVersion,
    buildkitVersion: request.buildkitVersion,
    arch: request.arch,
    limits: request.limits,
    target: request.target,
  };
  return createHash("sha256").update(canonicalize(inputs), "utf-8").digest("hex");
}

export function planLabRun(request: LabRunRequest): LabPlanResult {
  const issues: LabPlanIssue[] = [];
  const add = (code: LabPlanIssue["code"], message: string) =>
    issues.push({ code, message });

  if (!RUN_ID_RE.test(request.runId)) {
    add(
      "LAB_RUN_ID_INVALID",
      "runId precisa ter 6-49 caracteres minúsculos, números e hífen, começando por letra/número.",
    );
  }
  const concurrent = (request.existingRunIds ?? []).filter((id) => id !== request.runId);
  if (concurrent.length > 0) {
    add(
      "LAB_RUN_CONCURRENT",
      `já existe execução de laboratório ativa (${concurrent.join(", ")}); a medição precisa ser exclusiva`,
    );
  }
  if (!request.projectId.trim()) add("LAB_INPUT_INVALID", "projectId é obrigatório.");
  if (!request.commitSha.trim()) add("LAB_INPUT_INVALID", "commitSha é obrigatório.");
  if (!isSha256(request.dockerfileSha256)) {
    add("LAB_INPUT_INVALID", "dockerfileSha256 precisa ser SHA-256.");
  }
  if (request.lockfileSha256 !== null && !isSha256(request.lockfileSha256)) {
    add("LAB_INPUT_INVALID", "lockfileSha256 precisa ser SHA-256 ou null.");
  }
  if (request.baseImageId !== null && !/^sha256:[a-f0-9]{12,64}$/i.test(request.baseImageId)) {
    add("LAB_INPUT_INVALID", "baseImageId precisa ser um digest sha256:... quando informado.");
  }
  if (request.cacheState === "unknown") {
    add("LAB_INPUT_INVALID", "cacheState precisa ser cold ou warm (unknown não é aceitável em relatório).");
  }

  const limits = request.limits;
  if (
    !positiveInteger(limits.buildMemoryMb) ||
    !positiveInteger(limits.buildCpus) ||
    !positiveInteger(limits.stagingMemoryMb) ||
    !positiveInteger(limits.stagingCpus) ||
    limits.buildSwapMb < limits.buildMemoryMb ||
    limits.stagingSwapMb < limits.stagingMemoryMb ||
    limits.mongoMemoryMb <= 0
  ) {
    add(
      "LAB_INPUT_INVALID",
      "limites inválidos: memória/CPU positivos e swap >= memória (swap igual = swap proibido).",
    );
  }
  if (limits.buildSwapMb > limits.buildMemoryMb) {
    add("LAB_INPUT_INVALID", "swap do build precisa ser igual à memória (swap proibido na medição).");
  }

  const diskEstimate = estimateLabDiskMb();
  const host = request.host;
  if (host.memAvailableMb === null) {
    add("LAB_HOST_MEMORY", "MemAvailable não pôde ser lido; medição bloqueada (fail-closed).");
  } else {
    const needed = Math.max(limits.buildMemoryMb, limits.stagingMemoryMb) + DEFAULT_HOST_MEMORY_RESERVE_MB;
    if (host.memAvailableMb < needed) {
      add(
        "LAB_HOST_MEMORY",
        `RAM insuficiente: ${host.memAvailableMb} MB livres, necessário ${needed} MB ` +
          `(maior limite + ${DEFAULT_HOST_MEMORY_RESERVE_MB} MB de reserva do host)`,
      );
    }
  }
  if (host.diskFreeMb === null) {
    add("LAB_HOST_DISK", "disco livre não pôde ser lido; medição bloqueada.");
  } else if (host.diskFreeMb < diskEstimate.totalMb) {
    add(
      "LAB_HOST_DISK",
      `disco insuficiente: ${host.diskFreeMb} MB livres, estimativa ${diskEstimate.totalMb} MB ` +
        `(base ${diskEstimate.baseImageMb} + cache ${diskEstimate.buildCacheMb} + ` +
        `export ${diskEstimate.imageExportMb} + reserva ${diskEstimate.reserveMb})`,
    );
  }
  if (host.cpuCount === null || host.cpuCount < limits.buildCpus) {
    add("LAB_HOST_CPU", "host sem CPUs suficientes para o limite de build solicitado.");
  }
  if (!host.arch) add("LAB_TARGET_UNKNOWN", "arquitetura do host não identificada.");
  if (!request.target.arch) add("LAB_TARGET_UNKNOWN", "arquitetura do ambiente de destino não informada.");

  if (issues.length > 0) return { ok: false, issues, plan: null };

  const projectSlug = sanitizeSlug(request.projectId, 24) || "project";
  const runSlug = request.runId.slice(0, 12);
  const prefix = `korrelo-lab-${runSlug}`.replace(/-+$/, "");

  return {
    ok: true,
    issues: [],
    plan: {
      runId: request.runId,
      projectSlug,
      resources: {
        builderName: `${prefix}-builder`,
        builderContainerName: `buildx_buildkit_${prefix}-builder0`,
        imageTag: `${prefix}-${projectSlug}:measure`,
        stagingContainerName: `${prefix}-staging`,
        mongoContainerName: `${prefix}-mongo`,
        networkName: `${prefix}-net`,
        anonymousVolumesAllowed: false,
      },
      limits,
      diskEstimate,
      cacheState: request.cacheState,
      readOnlyEvidence: true,
    },
  };
}

/**
 * Classifica o resultado bruto do build.
 *
 * OOM tem prioridade sobre timeout: um build morto por memória pode também
 * estourar o tempo. Nunca tratar exit 0 com amostragem incompleta como
 * sucesso — vira `collection-failure`.
 */
export function classifyBuildOutcome(raw: LabRawResult): { outcome: LabOutcome; reasons: string[] } {
  const log = `${raw.logTail ?? ""}\n${raw.errorMessage ?? ""}`;
  const reasons: string[] = [];

  const oomByCgroup = raw.oomKilled || (raw.oomEvents ?? 0) > 0;
  const oomByExit = raw.exitCode === 137 && raw.timedOut !== true;
  const oomByLog = OOM_PATTERNS.some((pattern) => pattern.test(log));
  if (oomByCgroup || oomByExit || oomByLog) {
    if (oomByCgroup) reasons.push("cgroup reportou OOM");
    if (oomByExit) reasons.push("exit code 137 (SIGKILL)");
    if (oomByLog) reasons.push("log contém sinal de falta de memória");
    return { outcome: "oom", reasons };
  }

  if (raw.timedOut) {
    return { outcome: "timeout", reasons: ["tempo máximo de build excedido"] };
  }

  if (raw.exitCode === null) {
    return { outcome: "incomplete", reasons: ["processo não retornou código de saída"] };
  }

  if (raw.exitCode === 0) {
    if (!raw.samples || raw.peakMb === null) {
      return { outcome: "collection-failure", reasons: ["build terminou, mas a memória não foi medida"] };
    }
    if (!raw.samplingComplete) {
      return { outcome: "collection-failure", reasons: ["amostragem de memória incompleta"] };
    }
    return { outcome: "success", reasons: [] };
  }

  if (EXTERNAL_FAILURE_PATTERNS.some((pattern) => pattern.test(log))) {
    return { outcome: "external-failure", reasons: ["falha de rede/registro/dependência externa"] };
  }

  return {
    outcome: "external-failure",
    reasons: [`build falhou com exit code ${raw.exitCode} sem evidência de OOM`],
  };
}

/** Classifica o staging; health reprovado NÃO é OOM por si só. */
export function classifyStagingOutcome(raw: LabRawResult): { outcome: LabOutcome; reasons: string[] } {
  const base = classifyBuildOutcome({ ...raw, timedOut: false });
  if (base.outcome !== "success") return base;
  if (raw.healthOk !== true) {
    return { outcome: "external-failure", reasons: ["staging não respondeu ao healthcheck"] };
  }
  return { outcome: "success", reasons: [] };
}

export function assessTargetMatch(
  lab: LabHostCapacity,
  target: LabTargetEnvironment,
): { matches: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!lab.arch || !target.arch || lab.arch !== target.arch) {
    reasons.push(`arquitetura diferente (lab=${lab.arch ?? "?"}, destino=${target.arch ?? "?"})`);
  }
  if (lab.cgroupVersion !== target.cgroupVersion) {
    reasons.push(
      `cgroup diferente (lab=v${lab.cgroupVersion ?? "?"}, destino=v${target.cgroupVersion ?? "?"})`,
    );
  }
  const labMajor = dockerMajor(lab.dockerVersion ?? null);
  const targetMajor = dockerMajor(target.dockerVersion);
  if (labMajor !== null && targetMajor !== null && labMajor !== targetMajor) {
    reasons.push(`Docker major diferente (lab=${labMajor}, destino=${targetMajor})`);
  }
  if (
    typeof lab.totalMemMb === "number" &&
    lab.totalMemMb > 0 &&
    typeof target.totalMemMb === "number" &&
    target.totalMemMb > 0
  ) {
    const ratio = target.totalMemMb / lab.totalMemMb;
    // Diferença grande de RAM muda o comportamento do kernel/caches: o perfil
    // continua válido como evidência, mas não como alta confiança.
    if (ratio < 0.5 || ratio > 2) {
      reasons.push(
        `RAM do destino (${target.totalMemMb} MB) muito diferente do laboratório (${lab.totalMemMb} MB)`,
      );
    }
  }
  return { matches: reasons.length === 0, reasons };
}

function dockerMajor(version: string | null): number | null {
  if (!version) return null;
  const match = /^(\d+)\./.exec(version.trim());
  return match ? Number(match[1]) : null;
}

export interface BuildLabProfileParams {
  request: LabRunRequest;
  plan: LabRunPlan;
  measuredAt: string;
  buildRaw: LabRawResult;
  stagingRaw: LabRawResult;
  imageDigest: string | null;
  /** Nome da imagem-base resolvida (ex.: node:22-alpine@sha256:...). */
  notes?: string[];
}

/**
 * Monta o perfil final no formato da Fase C.3a.
 *
 * - `build.peakMb`/`staging.peakMb` vêm do cgroup (nunca só do processo Node);
 * - OOM marca `complete=true` (a medição cobriu o ciclo) mas o perfil fica
 *   `unsafe` na avaliação e `confidence=low`;
 * - `allowedForReservationReduction` é sempre false nesta fase.
 */
export function buildLabProfile(params: BuildLabProfileParams): LabResourceProfile {
  const { request, plan, buildRaw, stagingRaw, imageDigest } = params;
  const buildClass = classifyBuildOutcome(buildRaw);
  const stagingClass = classifyStagingOutcome(stagingRaw);
  const targetMatch = assessTargetMatch(request.host, request.target);

  const build: BuildMeasurement = {
    memoryLimitMb: request.limits.buildMemoryMb,
    limitEnforced: true,
    peakMb: buildRaw.peakMb,
    oomKilled: buildRaw.oomKilled,
    oomEvents: buildRaw.oomEvents ?? 0,
    psiSomePeak: buildRaw.pressureSomePeak ?? null,
    psiFullPeak: buildRaw.pressureFullPeak ?? null,
    durationMs: buildRaw.durationMs,
    complete: buildClass.outcome === "success" || buildClass.outcome === "oom",
    stepPeaks: [],
  };

  const staging: StagingMeasurement = {
    memoryLimitMb: request.limits.stagingMemoryMb,
    bootPeakMb: stagingRaw.peakMb,
    steadyPeakMb: null,
    peakMb: stagingRaw.peakMb,
    oomKilled: stagingRaw.oomKilled,
    oomEvents: stagingRaw.oomEvents ?? 0,
    psiSomePeak: stagingRaw.pressureSomePeak ?? null,
    psiFullPeak: stagingRaw.pressureFullPeak ?? null,
    healthOk: stagingRaw.healthOk === true,
    bootDurationMs: stagingRaw.durationMs,
    complete: stagingClass.outcome === "success" || stagingClass.outcome === "oom",
  };

  const notes = [
    ...(params.notes ?? []),
    `cache=${request.cacheState}`,
    `buildOutcome=${buildClass.outcome}`,
    `stagingOutcome=${stagingClass.outcome}`,
    ...buildClass.reasons.map((reason) => `build: ${reason}`),
    ...stagingClass.reasons.map((reason) => `staging: ${reason}`),
    ...targetMatch.reasons.map((reason) => `destino: ${reason}`),
    "perfil de laboratório; não autoriza reduzir reservas nesta fase",
  ];

  const profile: LabResourceProfile = {
    schemaVersion: RESOURCE_PROFILE_SCHEMA_VERSION,
    fingerprint: {
      projectId: request.projectId,
      commitSha: request.commitSha,
      dockerfileSha256: request.dockerfileSha256,
      lockfileSha256: request.lockfileSha256,
      imageDigest,
      buildMemoryLimitMb: request.limits.buildMemoryMb,
      stagingMemoryLimitMb: request.limits.stagingMemoryMb,
    },
    measuredAt: params.measuredAt,
    validUntil: null,
    environment: "lab" as ProfileEnvironment,
    run: { id: plan.runId, exclusive: true, concurrentMeasurements: 0 },
    build,
    staging,
    confidence: "low",
    notes,
    lab: {
      dockerVersion: request.dockerVersion,
      buildkitVersion: request.buildkitVersion,
      arch: request.arch,
      cacheState: request.cacheState,
      baseImageId: request.baseImageId,
      imageDigest,
      host: request.host,
      target: request.target,
      buildOutcome: buildClass.outcome,
      stagingOutcome: stagingClass.outcome,
      inputsFingerprint: computeLabInputsFingerprint(request),
      targetMatches: targetMatch.matches,
      targetMismatchReasons: targetMatch.reasons,
      exclusive: true,
      allowedForReservationReduction: false,
      notes,
    },
  };

  profile.confidence = deriveLabConfidence(profile);
  return profile;
}

/**
 * Confiança do laboratório: parte da confiança do modelo e REBAIXA quando o
 * ambiente de destino não corresponde. Build concluído não basta.
 */
export function deriveLabConfidence(profile: LabResourceProfile): "low" | "medium" | "high" {
  const base = deriveProfileConfidence(profile);
  if (base === "low") return "low";
  if (
    profile.lab.buildOutcome !== "success" ||
    profile.lab.stagingOutcome !== "success" ||
    !profile.lab.targetMatches ||
    profile.lab.cacheState === "unknown" ||
    !isImageDigest(profile.fingerprint.imageDigest)
  ) {
    return "medium";
  }
  return base;
}

export interface LabCleanupPlan {
  ok: boolean;
  issues: string[];
  /** Comandos explícitos; nunca prune, nunca curinga. */
  commands: string[][];
}

/**
 * Plano de limpeza estritamente limitado à execução.
 *
 * Qualquer recurso cujo nome não comece por `korrelo-lab-` e não contenha o
 * runId faz o plano FALHAR INTEIRO — melhor deixar resíduo do que remover
 * algo de outro projeto.
 */
export function planLabCleanup(params: {
  runId: string;
  builderName: string;
  containers: string[];
  networks: string[];
  volumes: string[];
  imageTags: string[];
}): LabCleanupPlan {
  const issues: string[] = [];
  const owned = (name: string): boolean =>
    name.startsWith("korrelo-lab-") && name.includes(params.runId.slice(0, 12));
  const builderOwned =
    params.builderName.startsWith("korrelo-lab-") && params.builderName.includes(params.runId.slice(0, 12));

  if (!builderOwned) issues.push(`builder fora do escopo da execução: ${params.builderName}`);
  for (const name of params.containers) if (!owned(name)) issues.push(`container fora do escopo: ${name}`);
  for (const name of params.networks) if (!owned(name)) issues.push(`rede fora do escopo: ${name}`);
  for (const name of params.volumes) if (!owned(name)) issues.push(`volume fora do escopo: ${name}`);
  for (const tag of params.imageTags) {
    if (!tag.startsWith("korrelo-lab-") || !tag.includes(params.runId.slice(0, 12))) {
      issues.push(`imagem fora do escopo: ${tag}`);
    }
  }
  if (issues.length > 0) return { ok: false, issues, commands: [] };

  const commands: string[][] = [];
  for (const container of params.containers) commands.push(["docker", "rm", "-f", container]);
  for (const network of params.networks) commands.push(["docker", "network", "rm", network]);
  for (const volume of params.volumes) commands.push(["docker", "volume", "rm", volume]);
  commands.push(["docker", "buildx", "rm", params.builderName]);
  for (const tag of params.imageTags) commands.push(["docker", "rmi", tag]);
  return { ok: true, issues: [], commands };
}

/** Uma execução por host: qualquer outro run ativo invalida a exclusividade. */
export function assessLabConcurrency(existingRunIds: string[], runId: string): {
  exclusive: boolean;
  others: string[];
} {
  const others = existingRunIds.filter((id) => id !== runId);
  return { exclusive: others.length === 0, others };
}
