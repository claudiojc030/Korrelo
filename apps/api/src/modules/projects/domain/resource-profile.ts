/**
 * PERFIL REAL DE BUILD E STAGING (Resource Manager V1 — Fase C.3).
 *
 * Um perfil é a MEDIÇÃO de quanto um projeto específico consome durante o
 * build e durante o staging, amarrada a um fingerprint do que foi medido.
 *
 * Regras invioláveis desta fase:
 *  - nenhum perfil altera preflight, margens, fila ou decisão de deploy;
 *  - perfil ausente, incompleto, de outro projeto, de outro commit/imagem ou
 *    expirado NUNCA é evidência válida;
 *  - OOM observado marca o perfil como inseguro para reduzir reservas;
 *  - medições concorrentes invalidam o perfil (não é possível atribuir o
 *    consumo a um único build/staging);
 *  - falha de leitura do cgroup vira `null` e torna a medição incompleta.
 *
 * Este módulo é PURO: não lê disco, Docker, /proc ou banco. Toda a decisão é
 * função dos dados recebidos, o que permite testar os casos ruins sem rodar
 * um build real.
 */

import { createHash } from "node:crypto";

export const RESOURCE_PROFILE_SCHEMA_VERSION = 1;

/** Validade padrão de um perfil: 30 dias. */
export const DEFAULT_PROFILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type ProfileEnvironment = "lab" | "production";
export type ProfileConfidence = "low" | "medium" | "high";

export type ProfileStatus =
  | "valid"
  | "absent"
  | "invalid"
  | "stale"
  | "incomplete"
  | "inconsistent"
  | "concurrent"
  | "unsafe";

/**
 * Identidade do que foi medido. Se QUALQUER campo relevante mudar, o perfil
 * deixa de descrever o artefato atual e não pode ser usado como evidência.
 */
export interface ResourceProfileFingerprint {
  projectId: string;
  commitSha: string;
  /** SHA-256 do Dockerfile efetivamente usado (próprio ou gerado). */
  dockerfileSha256: string;
  /** SHA-256 do lockfile; null quando o projeto não tem lockfile. */
  lockfileSha256: string | null;
  /** Digest da imagem construída, quando conhecido. */
  imageDigest: string | null;
  /** Limite de memória do build que estava em vigor na medição. */
  buildMemoryLimitMb: number;
  /** Limite de memória do container de staging na medição. */
  stagingMemoryLimitMb: number;
}

export interface BuildStepPeak {
  step: string;
  peakMb: number;
}

export interface BuildMeasurement {
  memoryLimitMb: number;
  /** true quando o limite era realmente aplicado por cgroup. */
  limitEnforced: boolean;
  /** Pico real do cgroup do builder; null = leitura indisponível. */
  peakMb: number | null;
  oomKilled: boolean;
  oomEvents: number;
  psiSomePeak: number | null;
  psiFullPeak: number | null;
  durationMs: number | null;
  /** true só quando o build terminou e a medição cobriu o ciclo inteiro. */
  complete: boolean;
  stepPeaks: BuildStepPeak[];
}

export interface StagingMeasurement {
  memoryLimitMb: number;
  /** Pico durante a inicialização (antes do health check passar). */
  bootPeakMb: number | null;
  /** Pico depois do health check, em regime. */
  steadyPeakMb: number | null;
  /** Maior pico observado (cgroup ou amostragem). */
  peakMb: number | null;
  oomKilled: boolean;
  oomEvents: number;
  psiSomePeak: number | null;
  psiFullPeak: number | null;
  healthOk: boolean;
  bootDurationMs: number | null;
  complete: boolean;
}

export interface ProfileMeasurementRun {
  /** Identificador único da execução de laboratório. */
  id: string;
  /**
   * true somente quando nenhum outro build/staging rodava na mesma janela.
   * Sem exclusividade, o consumo não é atribuível a este projeto.
   */
  exclusive: boolean;
  /** Quantos outros builds/stagings foram observados na janela. */
  concurrentMeasurements: number;
}

export interface ResourceProfile {
  schemaVersion: number;
  fingerprint: ResourceProfileFingerprint;
  /** ISO-8601 da medição. */
  measuredAt: string;
  /** ISO-8601; null = usa a validade padrão. */
  validUntil: string | null;
  environment: ProfileEnvironment;
  run: ProfileMeasurementRun;
  build: BuildMeasurement;
  staging: StagingMeasurement;
  /** Derivada dos dados; nunca informada "na mão" para cima. */
  confidence: ProfileConfidence;
  notes?: string[];
}

/** Chave esperada no momento de usar (ou validar) um perfil. */
export interface ExpectedProfileKey {
  projectId: string;
  commitSha: string;
  dockerfileSha256: string;
  lockfileSha256: string | null;
  /** Digest pode ser desconhecido antes do build; se informado, tem de casar. */
  imageDigest?: string | null;
  buildMemoryLimitMb: number;
  stagingMemoryLimitMb: number;
}

export interface ProfileEvaluation {
  status: ProfileStatus;
  /** true somente para evidência válida (valid + confiança não-baixa). */
  usable: boolean;
  confidence: ProfileConfidence;
  reasons: string[];
}

const SHA256_RE = /^[a-f0-9]{64}$/i;
const IMAGE_DIGEST_RE = /^sha256:[a-f0-9]{64}$/i;

/** Serialização determinística (chaves ordenadas, arrays preservados). */
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

/** Fingerprint estável de um conjunto de identidade de perfil. */
export function computeProfileFingerprint(fingerprint: ResourceProfileFingerprint): string {
  return createHash("sha256").update(canonicalize(fingerprint), "utf-8").digest("hex");
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

export function isImageDigest(value: unknown): value is string {
  return typeof value === "string" && IMAGE_DIGEST_RE.test(value);
}

/**
 * Confiança derivada SOMENTE dos dados da medição.
 *
 * - high: laboratório, execução exclusiva, build e staging completos, picos
 *   reais presentes, limites aplicados, PSI presente e digest conhecido;
 * - medium: completa e consistente, mas falta alguma evidência secundária
 *   (PSI, digest ou limite de build realmente aplicado);
 * - low: incompleta, sem pico real ou com OOM.
 */
export function deriveProfileConfidence(profile: ResourceProfile): ProfileConfidence {
  const build = profile.build;
  const staging = profile.staging;

  if (
    !build ||
    !staging ||
    !build.complete ||
    !staging.complete ||
    build.peakMb === null ||
    staging.peakMb === null
  ) {
    return "low";
  }
  if (build.oomKilled || staging.oomKilled || build.oomEvents > 0 || staging.oomEvents > 0) {
    return "low";
  }

  const strong =
    profile.environment === "lab" &&
    profile.run?.exclusive === true &&
    profile.run.concurrentMeasurements === 0 &&
    build.limitEnforced === true &&
    build.psiSomePeak !== null &&
    build.psiFullPeak !== null &&
    staging.psiSomePeak !== null &&
    staging.psiFullPeak !== null &&
    staging.healthOk === true &&
    profile.fingerprint?.imageDigest !== null &&
    isImageDigest(profile.fingerprint?.imageDigest);

  return strong ? "high" : "medium";
}

function sameNullableString(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** Forma mínima de um perfil vindo de JSON (pode estar corrompido ou velho). */
function isProfileShape(value: unknown): value is ResourceProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<ResourceProfile>;
  const fingerprint = profile.fingerprint as Partial<ResourceProfileFingerprint> | undefined;
  const build = profile.build as Partial<BuildMeasurement> | undefined;
  const staging = profile.staging as Partial<StagingMeasurement> | undefined;
  return (
    typeof profile.schemaVersion === "number" &&
    !!fingerprint &&
    typeof fingerprint.projectId === "string" &&
    fingerprint.projectId.length > 0 &&
    typeof fingerprint.commitSha === "string" &&
    fingerprint.commitSha.length > 0 &&
    isSha256(fingerprint.dockerfileSha256) &&
    (fingerprint.lockfileSha256 === null || isSha256(fingerprint.lockfileSha256)) &&
    (fingerprint.imageDigest === null || typeof fingerprint.imageDigest === "string") &&
    positiveInteger(fingerprint.buildMemoryLimitMb) &&
    positiveInteger(fingerprint.stagingMemoryLimitMb) &&
    !!build &&
    !!staging &&
    (profile.environment === "lab" || profile.environment === "production") &&
    !!profile.run &&
    typeof profile.run.id === "string" &&
    typeof profile.run.exclusive === "boolean" &&
    typeof profile.run.concurrentMeasurements === "number"
  );
}

/**
 * Avalia se um perfil é evidência válida para a chave esperada.
 *
 * NUNCA lança: JSON corrompido, campos faltando ou tipos errados resultam em
 * `invalid`. Perfil ausente resulta em `absent`. Em ambos os casos
 * `usable=false` e o chamador deve cair no fallback conservador.
 */
export function evaluateResourceProfile(
  profile: ResourceProfile | null | undefined,
  expected: ExpectedProfileKey,
  options: { now?: number; maxAgeMs?: number } = {},
): ProfileEvaluation {
  const now = options.now ?? Date.now();
  const maxAgeMs = positiveInteger(options.maxAgeMs) ? options.maxAgeMs : DEFAULT_PROFILE_TTL_MS;

  if (!profile) {
    return { status: "absent", usable: false, confidence: "low", reasons: ["perfil ausente"] };
  }
  if (!isProfileShape(profile)) {
    return { status: "invalid", usable: false, confidence: "low", reasons: ["perfil com formato inválido"] };
  }
  if (profile.schemaVersion !== RESOURCE_PROFILE_SCHEMA_VERSION) {
    return {
      status: "invalid",
      usable: false,
      confidence: "low",
      reasons: [`schemaVersion ${profile.schemaVersion} não suportada`],
    };
  }

  const fingerprint = profile.fingerprint;

  if (fingerprint.projectId !== expected.projectId) {
    return {
      status: "stale",
      usable: false,
      confidence: "low",
      reasons: ["perfil pertence a outro projeto"],
    };
  }

  const mismatch: string[] = [];
  if (fingerprint.commitSha !== expected.commitSha) mismatch.push("commit diferente");
  if (fingerprint.dockerfileSha256 !== expected.dockerfileSha256) mismatch.push("Dockerfile diferente");
  if (!sameNullableString(fingerprint.lockfileSha256, expected.lockfileSha256)) {
    mismatch.push("lockfile diferente");
  }
  if (
    expected.imageDigest !== undefined &&
    expected.imageDigest !== null &&
    !sameNullableString(fingerprint.imageDigest, expected.imageDigest)
  ) {
    mismatch.push("digest de imagem diferente");
  }
  if (fingerprint.buildMemoryLimitMb !== expected.buildMemoryLimitMb) {
    mismatch.push("limite de build diferente");
  }
  if (fingerprint.stagingMemoryLimitMb !== expected.stagingMemoryLimitMb) {
    mismatch.push("limite de staging diferente");
  }
  if (mismatch.length > 0) {
    return { status: "stale", usable: false, confidence: "low", reasons: mismatch };
  }

  return assessProfileEvidence(profile, { now, maxAgeMs });
}

/**
 * Avalia o CONTEÚDO de um perfil (validade, OOM, completude, consistência)
 * sem comparar com uma chave esperada.
 *
 * Usado pelo painel/persistência para explicar por que uma medição guardada
 * não é evidência utilizável. NUNCA promove um perfil por si só.
 */
export function assessProfileEvidence(
  profile: ResourceProfile | null | undefined,
  options: { now?: number; maxAgeMs?: number } = {},
): ProfileEvaluation {
  const now = options.now ?? Date.now();
  const maxAgeMs = positiveInteger(options.maxAgeMs) ? options.maxAgeMs : DEFAULT_PROFILE_TTL_MS;

  if (!profile) {
    return { status: "absent", usable: false, confidence: "low", reasons: ["perfil ausente"] };
  }
  if (!isProfileShape(profile)) {
    return { status: "invalid", usable: false, confidence: "low", reasons: ["perfil com formato inválido"] };
  }
  if (profile.schemaVersion !== RESOURCE_PROFILE_SCHEMA_VERSION) {
    return {
      status: "invalid",
      usable: false,
      confidence: "low",
      reasons: [`schemaVersion ${profile.schemaVersion} não suportada`],
    };
  }

  const measuredAt = Date.parse(profile.measuredAt);
  if (!isIsoDate(profile.measuredAt) || measuredAt > now + 5 * 60_000) {
    return {
      status: "inconsistent",
      usable: false,
      confidence: "low",
      reasons: ["data da medição inválida ou no futuro"],
    };
  }
  const ageMs = Math.max(0, now - measuredAt);
  const validUntilMs = profile.validUntil === null ? measuredAt + maxAgeMs : Date.parse(profile.validUntil);
  if (!Number.isFinite(validUntilMs)) {
    return {
      status: "inconsistent",
      usable: false,
      confidence: "low",
      reasons: ["validade do perfil inválida"],
    };
  }
  if (now > validUntilMs || ageMs > maxAgeMs) {
    return { status: "stale", usable: false, confidence: "low", reasons: ["perfil expirado"] };
  }

  if (profile.run.concurrentMeasurements > 0 || profile.run.exclusive !== true) {
    return {
      status: "concurrent",
      usable: false,
      confidence: "low",
      reasons: ["medição concorrente: consumo não atribuível a este projeto"],
    };
  }

  if (
    profile.build.oomKilled ||
    profile.staging.oomKilled ||
    profile.build.oomEvents > 0 ||
    profile.staging.oomEvents > 0
  ) {
    return {
      status: "unsafe",
      usable: false,
      confidence: "low",
      reasons: ["OOM observado durante a medição"],
    };
  }

  if (
    !profile.build.complete ||
    !profile.staging.complete ||
    profile.build.peakMb === null ||
    profile.staging.peakMb === null
  ) {
    return {
      status: "incomplete",
      usable: false,
      confidence: "low",
      reasons: ["medição incompleta (pico real indisponível)"],
    };
  }

  const stagingLimit = profile.staging.memoryLimitMb;
  if (
    !positiveInteger(profile.build.peakMb) ||
    !positiveInteger(profile.staging.peakMb) ||
    profile.staging.peakMb > stagingLimit ||
    (profile.staging.bootPeakMb !== null && profile.staging.bootPeakMb > stagingLimit) ||
    (profile.staging.steadyPeakMb !== null && profile.staging.steadyPeakMb > stagingLimit) ||
    profile.build.peakMb > profile.build.memoryLimitMb * 4
  ) {
    return {
      status: "inconsistent",
      usable: false,
      confidence: "low",
      reasons: ["valores medidos inconsistentes com os limites registrados"],
    };
  }

  const confidence = deriveProfileConfidence(profile);
  return {
    status: "valid",
    usable: confidence !== "low",
    confidence,
    reasons: confidence === "low" ? ["evidência insuficiente"] : [],
  };
}

/**
 * Validação estrutural usada antes de persistir. Não decide se o perfil é
 * utilizável — apenas impede gravar JSON quebrado.
 */
export function validateResourceProfile(value: unknown): { valid: boolean; errors: string[] } {
  if (!isProfileShape(value)) return { valid: false, errors: ["formato inválido"] };
  const errors: string[] = [];
  if (value.schemaVersion !== RESOURCE_PROFILE_SCHEMA_VERSION) {
    errors.push(`schemaVersion não suportada: ${value.schemaVersion}`);
  }
  if (!isIsoDate(value.measuredAt)) errors.push("measuredAt inválido");
  if (value.validUntil !== null && !isIsoDate(value.validUntil)) errors.push("validUntil inválido");
  const positiveOrNull = (entry: unknown) => entry === null || positiveInteger(entry);
  if (!positiveInteger(value.build.memoryLimitMb)) errors.push("build.memoryLimitMb inválido");
  if (!positiveInteger(value.staging.memoryLimitMb)) errors.push("staging.memoryLimitMb inválido");
  if (!positiveOrNull(value.build.peakMb)) errors.push("build.peakMb inválido");
  if (!positiveOrNull(value.staging.peakMb)) errors.push("staging.peakMb inválido");
  if (!positiveOrNull(value.staging.bootPeakMb)) errors.push("staging.bootPeakMb inválido");
  if (!positiveOrNull(value.staging.steadyPeakMb)) errors.push("staging.steadyPeakMb inválido");
  if (!Number.isFinite(value.build.oomEvents) || value.build.oomEvents < 0) {
    errors.push("build.oomEvents inválido");
  }
  if (!Number.isFinite(value.staging.oomEvents) || value.staging.oomEvents < 0) {
    errors.push("staging.oomEvents inválido");
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Conveniência para o painel: identifica o perfil mais recente que descreve
 * exatamente a chave esperada. Perfis inválidos são ignorados; nenhum deles
 * é "promovido" por engano.
 */
export function selectLatestCompatibleProfile(
  profiles: ResourceProfile[],
  expected: ExpectedProfileKey,
  options: { now?: number; maxAgeMs?: number } = {},
): ResourceProfile | null {
  const evaluations = profiles
    .filter((profile) => evaluateResourceProfile(profile, expected, options).status === "valid")
    .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt));
  return evaluations[0] ?? null;
}
