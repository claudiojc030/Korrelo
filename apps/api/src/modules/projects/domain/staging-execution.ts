import type { StagingComposeDocument, StagingComposeHealthcheck } from "./staging-compose";
import type { StagingPortLease } from "./staging-lease";
import type { StagingPlan, StagingResourceRequest } from "./staging-planner";
import type { StagingCapacityPolicy } from "./staging-capacity";
import type { StagingRun } from "./staging-run";

/**
 * P1C/P1D — CONTRATOS DO EXECUTOR INTERNO.
 *
 * Estes contratos não executam Docker por si mesmos. O executor recebe
 * adaptadores injetados; em produção ele permanece desabilitado por flag.
 */

export type StagingExecutionMode = "local-build" | "prebuilt";

export interface StagingImageIdentityInput {
  projectId: string;
  /** Identificadores aceitos além do projectId (ex.: slug do projeto). */
  projectAliases?: string[];
  commitSha: string;
  imageReference: string;
  expectedImageId?: string | null;
  expectedDigest?: string | null;
  expectedOs?: string | null;
  expectedArchitecture?: string | null;
  observed: {
    imageId: string;
    repoDigests: string[];
    labels: Record<string, string>;
    architecture?: string | null;
    os?: string | null;
  };
}

export interface StagingImageIdentityResult {
  ok: boolean;
  identityVerified: boolean;
  originAuthenticated: false;
  imageId: string | null;
  digest: string | null;
  issues: string[];
}

/**
 * Verifica identidade LOCAL e correspondência com projeto/commit.
 * NÃO é autenticação de origem/assinatura. Imagem `latest` é recusada.
 */
export function verifyPrebuiltImageIdentity(input: StagingImageIdentityInput): StagingImageIdentityResult {
  const issues: string[] = [];
  const imageId = input.observed.imageId?.trim() || null;
  if (!imageId || !/^sha256:[a-f0-9]{64}$/i.test(imageId)) {
    issues.push("image ID Docker ausente ou inválido");
  }
  if (isLatestReference(input.imageReference)) {
    issues.push("tag latest não é evidência de identidade");
  }
  if (input.observed.labels["korrelo.projectId"] !== input.projectId) {
    const accepted = new Set(
      [input.projectId, ...(input.projectAliases ?? [])]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    );
    if (!accepted.has(input.observed.labels["korrelo.projectId"] ?? "")) {
      issues.push("label korrelo.projectId ausente ou divergente");
    }
  }
  if (input.observed.labels["korrelo.commitSha"] !== input.commitSha) {
    issues.push("label korrelo.commitSha ausente ou divergente");
  }
  if (input.expectedImageId && imageId !== input.expectedImageId.trim()) {
    issues.push("image ID observado diverge do esperado");
  }
  if (input.expectedOs && input.observed.os?.toLowerCase() !== input.expectedOs.toLowerCase()) {
    issues.push("sistema operacional da imagem diverge do esperado");
  }
  if (
    input.expectedArchitecture &&
    input.observed.architecture?.toLowerCase() !== input.expectedArchitecture.toLowerCase()
  ) {
    issues.push("arquitetura da imagem diverge da esperada");
  }
  const expectedDigest = input.expectedDigest?.trim() || null;
  const digest =
    input.observed.repoDigests.find((entry) => entry.startsWith(repoName(input.imageReference) + "@")) ?? null;
  if (expectedDigest && digest !== expectedDigest && !input.observed.repoDigests.includes(expectedDigest)) {
    issues.push("digest observado diverge do esperado");
  }
  if (issues.length > 0) {
    return {
      ok: false,
      identityVerified: false,
      originAuthenticated: false,
      imageId,
      digest,
      issues,
    };
  }
  return {
    ok: true,
    identityVerified: true,
    originAuthenticated: false,
    imageId,
    digest,
    issues: [],
  };
}

function isLatestReference(reference: string): boolean {
  const trimmed = reference.trim();
  if (trimmed.endsWith(":latest")) return true;
  if (trimmed.includes("@")) return false;
  const lastSlash = trimmed.lastIndexOf("/");
  const lastColon = trimmed.lastIndexOf(":");
  return lastColon > lastSlash && trimmed.slice(lastColon + 1) === "latest";
}

function repoName(reference: string): string {
  const at = reference.indexOf("@");
  const beforeDigest = at >= 0 ? reference.slice(0, at) : reference;
  const lastColon = beforeDigest.lastIndexOf(":");
  return lastColon > beforeDigest.lastIndexOf("/") ? beforeDigest.slice(0, lastColon) : beforeDigest;
}

export interface StagingImageVerifier {
  verify(input: StagingImageIdentityInput): Promise<StagingImageIdentityResult>;
}

/** Slug aceito como alias de identidade (mesmo formato do nome do container). */
export function stagingProjectAlias(projectName: string | null | undefined): string | null {
  const slug = String(projectName ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || null;
}

export const STAGING_IMAGE_VERIFIER = Symbol("STAGING_IMAGE_VERIFIER");
export const STAGING_RUNTIME_ADAPTER = Symbol("STAGING_RUNTIME_ADAPTER");

export interface StagingRuntimeStartInput {
  run: StagingRun;
  lease: StagingPortLease;
  document: StagingComposeDocument;
  composeProject: string;
  /** Arquivos env por NOME ARQUIVO declarado no documento (valores nunca no hash). */
  envFiles?: Record<string, Record<string, string>>;
}

export interface StagingRuntimeHealthInput {
  run: StagingRun;
  lease: StagingPortLease;
  /** Sonda HTTP opcional no host (loopback) além do estado do container. */
  httpHealth?: {
    path: string;
    require2xx: boolean;
    /** Porta interna do container; preferida à porta publicada. */
    containerPort?: number;
  } | null;
}

export interface StagingRuntimeCleanupInput {
  run: StagingRun;
  lease: StagingPortLease | null;
  reason: string;
}

export interface StagingRuntimeAdapter {
  start(input: StagingRuntimeStartInput): Promise<void>;
  health(input: StagingRuntimeHealthInput): Promise<boolean>;
  promote?(input: StagingRuntimeHealthInput): Promise<void>;
  cleanup(input: StagingRuntimeCleanupInput): Promise<{ ok: boolean; reason?: string | null }>;
}

export interface StagingExecutionRequest {
  plan: StagingPlan;
  /** Commit completo correspondente ao plano/imagem. */
  commitSha: string;
  mode: StagingExecutionMode;
  compose: {
    containerPort: number;
    pidsLimit: number;
    imageReference?: string | null;
    buildContext?: string | null;
    dockerfile?: string | null;
    healthcheck?: StagingComposeHealthcheck | null;
    dependencyImages?: Record<string, string>;
    authorizedBindMounts?: string[];
  };
  imageIdentity?: StagingImageIdentityInput | null;
  /** Valores de ambiente do app (nunca vão para o documento/hash). */
  stagingEnv?: Record<string, string> | null;
  /** Ambiente por NOME da dependência (ex.: credenciais do Mongo). */
  dependencyEnvironment?: Record<string, Record<string, string>>;
  /** Healthcheck CMD-SHELL por NOME da dependência. */
  dependencyHealthchecks?: Record<string, string>;
  deployJobId?: string | null;
  ownerId?: string | null;
  portCandidates: number[];
  ttlMinutes: number;
  policy: StagingCapacityPolicy;
  app: StagingResourceRequest;
  dependencies: StagingResourceRequest[];
}

export interface StagingExecutionResult {
  ok: boolean;
  status: "disabled" | "blocked" | "started" | "healthy" | "promoted" | "cleaned" | "failed";
  run: StagingRun | null;
  lease: StagingPortLease | null;
  composeHash: string | null;
  issues: string[];
}
