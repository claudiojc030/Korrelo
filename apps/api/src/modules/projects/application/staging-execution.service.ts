import { Inject, Injectable, Optional } from "@nestjs/common";
import { WorkerLock } from "../infrastructure/worker-lock";
import {
  STAGING_RUN_REPOSITORY,
  type StagingRunRepository,
} from "../domain/staging-run";
import { STAGING_PORT_LEASE_REPOSITORY, type StagingPortLeaseRepository } from "../domain/staging-lease";
import {
  STAGING_IMAGE_VERIFIER,
  STAGING_RUNTIME_ADAPTER,
  type StagingExecutionRequest,
  type StagingExecutionResult,
  type StagingImageVerifier,
  type StagingRuntimeAdapter,
  type StagingRuntimeHealthInput,
} from "../domain/staging-execution";
import { generateStagingCompose, stagingVolumePrefix } from "../domain/staging-compose";

/**
 * Executor interno MÍNIMO.
 *
 * Desabilitado por padrão. A aquisição de WorkerLock, a reserva atômica e a
 * execução usam adaptadores injetados; nenhum Docker é chamado neste módulo.
 *
 * Ordem de locks:
 *   1. gera/valida Compose e identidade da imagem (sem locks)
 *   2. adquire WorkerLock (se ainda não for deste processo)
 *   3. reserva atômica de capacidade/porta/run no SQLite
 *   4. executa runtime e health
 *   5. promove somente após health aprovado
 *   6. cleanup escopado; libera WorkerLock somente se foi adquirido aqui
 */
@Injectable()
export class StagingExecutionService {
  constructor(
    @Inject(STAGING_RUN_REPOSITORY) private readonly runRepository: StagingRunRepository,
    private readonly workerLock: WorkerLock,
    @Inject(STAGING_IMAGE_VERIFIER) private readonly imageVerifier: StagingImageVerifier,
    @Inject(STAGING_RUNTIME_ADAPTER) private readonly runtime: StagingRuntimeAdapter,
    @Optional() private readonly enabled: boolean = process.env.KORRELO_STAGING_ISOLATED_EXECUTION === "true",
    @Optional()
    @Inject(STAGING_PORT_LEASE_REPOSITORY)
    private readonly leaseRepository: StagingPortLeaseRepository | null = null,
  ) {}

  async execute(
    request: StagingExecutionRequest,
    httpHealth: StagingRuntimeHealthInput["httpHealth"] = null,
  ): Promise<StagingExecutionResult> {
    if (!this.enabled) return result("disabled", null, null, null, ["execução de staging isolado desabilitada"]);
    if (!request.commitSha || !/^[a-f0-9]{40}$/i.test(request.commitSha)) {
      return result("blocked", null, null, null, ["commit SHA completo é obrigatório"]);
    }

    let verifiedImageId: string | null = null;
    let verifiedImageDigest: string | null = null;
    if (request.mode === "prebuilt") {
      if (!request.compose.imageReference || !request.imageIdentity) {
        return result("blocked", null, null, null, ["imagem pré-construída exige referência e identidade observada"]);
      }
      if (request.imageIdentity.imageReference !== request.compose.imageReference) {
        return result("blocked", null, null, null, ["identidade observada pertence a outra referência de imagem"]);
      }
      if (request.imageIdentity.projectId !== request.plan.projectId || request.imageIdentity.commitSha !== request.commitSha) {
        return result("blocked", null, null, null, ["identidade da imagem não corresponde ao projeto/commit do plano"]);
      }
      let identity;
      try {
        identity = await this.imageVerifier.verify(request.imageIdentity);
      } catch {
        return result("blocked", null, null, null, ["falha ao verificar identidade da imagem"]);
      }
      if (!identity.ok || !identity.identityVerified) {
        return result("blocked", null, null, null, identity.issues);
      }
      verifiedImageId = identity.imageId;
      verifiedImageDigest = identity.digest;
      request = { ...request, imageIdentity: { ...request.imageIdentity, expectedImageId: identity.imageId } };
    } else if (!request.compose.buildContext) {
      return result("blocked", null, null, null, ["build local exige contexto explícito"]);
    }

    const environmentFiles: Record<string, Record<string, string>> = {};
    const appEnvFile =
      request.stagingEnv && Object.keys(request.stagingEnv).length > 0 ? "staging-app.env" : null;
    if (appEnvFile) {
      const invalid = findInvalidEnvEntry(request.stagingEnv!);
      if (invalid) return result("blocked", null, null, null, [`variável de staging inválida: ${invalid}`]);
      environmentFiles[appEnvFile] = request.stagingEnv!;
    }
    const dependencyEnvFiles: Record<string, string> = {};
    for (const dependency of request.plan.dependencies ?? []) {
      const values = request.dependencyEnvironment?.[dependency.name];
      if (!values || Object.keys(values).length === 0) continue;
      const invalid = findInvalidEnvEntry(values);
      if (invalid) {
        return result("blocked", null, null, null, [`variável da dependência ${dependency.name} inválida`]);
      }
      const fileName = `staging-${dependency.name}.env`;
      dependencyEnvFiles[dependency.name] = fileName;
      environmentFiles[fileName] = values;
    }

    const generated = generateStagingCompose({
      plan: request.plan,
      containerPort: request.compose.containerPort,
      pidsLimit: request.compose.pidsLimit,
      imageReference: request.compose.imageReference,
      buildContext: request.compose.buildContext,
      dockerfile: request.compose.dockerfile,
      deployJobId: request.deployJobId,
      healthcheck: request.compose.healthcheck,
      dependencyImages: request.compose.dependencyImages,
      appEnvFile,
      dependencyEnvFiles,
      dependencyHealthchecks: request.dependencyHealthchecks,
      authorizedBindMounts: request.compose.authorizedBindMounts,
    });
    if (!generated.ok || !generated.document || !generated.planHash || !generated.composeHash) {
      return result("blocked", null, null, generated.composeHash, generated.issues.map((issue) => issue.message));
    }

    const alreadyHeld = this.workerLock.isHeldByMe();
    if (!alreadyHeld && !(await this.workerLock.acquire())) {
      return result("blocked", null, null, generated.composeHash, ["outro worker está em execução"]);
    }

    let active: { run: NonNullable<StagingExecutionResult["run"]>; lease: NonNullable<StagingExecutionResult["lease"]> } | null =
      null;
    let cleanupDone = false;

    try {
      let reservation;
      try {
        reservation = await this.runRepository.reserve({
          projectId: request.plan.projectId,
          deployJobId: request.deployJobId ?? null,
          runId: request.plan.runId,
          composeProject: request.plan.composeProject,
          planHash: generated.planHash,
          composeHash: generated.composeHash,
          imageReference: request.compose.imageReference ?? null,
          imageId: verifiedImageId,
          imageDigest: verifiedImageDigest,
          app: request.app,
          dependencies: request.dependencies,
          portCandidates: request.portCandidates,
          ttlMinutes: request.ttlMinutes,
          ownerId: request.ownerId ?? null,
          policy: request.policy,
          networkName: request.plan.network.name,
          volumePrefix: stagingVolumePrefix(request.plan),
        });
      } catch {
        return result("failed", null, null, generated.composeHash, ["falha ao reservar capacidade/porta"]);
      }
      if (!reservation.ok || !reservation.run || !reservation.lease) {
        return result("blocked", null, null, generated.composeHash, reservation.issues.map((issue) => issue.message));
      }
      active = { run: reservation.run, lease: reservation.lease };

      // A porta publicada pelo Compose é fixada a partir do plano; a reserva
      // atômica precisa confirmar exatamente a mesma porta antes de executar.
      if (reservation.lease.hostPort !== request.plan.app.hostPort) {
        await this.safeCleanup(reservation.run, reservation.lease, "porta reservada divergente do plano");
        await this.releaseLease(reservation.run);
        cleanupDone = true;
        return result("blocked", reservation.run, reservation.lease, generated.composeHash, [
          "porta reservada diverge da porta do Compose; execução bloqueada",
        ]);
      }

      let healthy = false;
      try {
        await this.runtime.start({
          run: reservation.run,
          lease: reservation.lease,
          document: generated.document,
          composeProject: request.plan.composeProject,
          envFiles: environmentFiles,
        });
        healthy = await this.runtime.health({ run: reservation.run, lease: reservation.lease, httpHealth });
      } catch (error) {
        await this.safeCleanup(reservation.run, reservation.lease, "falha ao iniciar/health");
        await this.releaseLease(reservation.run);
        cleanupDone = true;
        return result("failed", reservation.run, reservation.lease, generated.composeHash, [
          `falha ao executar o staging: ${detail(error)}`,
        ]);
      }
      if (!healthy) {
        await this.safeCleanup(reservation.run, reservation.lease, "health reprovado");
        await this.releaseLease(reservation.run);
        cleanupDone = true;
        return result("failed", reservation.run, reservation.lease, generated.composeHash, ["healthcheck do staging reprovado"]);
      }

      let promoted = false;
      if (this.runtime.promote) {
        try {
          await this.runtime.promote({ run: reservation.run, lease: reservation.lease });
          promoted = true;
        } catch {
          await this.safeCleanup(reservation.run, reservation.lease, "falha na promoção");
          await this.releaseLease(reservation.run);
          cleanupDone = true;
          return result("failed", reservation.run, reservation.lease, generated.composeHash, ["falha ao promover staging"]);
        }
      }

      const cleanup = await this.safeCleanup(reservation.run, reservation.lease, "conclusão");
      cleanupDone = true;
      if (!cleanup.ok) {
        await this.releaseLease(reservation.run);
        return result("failed", reservation.run, reservation.lease, generated.composeHash, [
          cleanup.reason ?? "falha no cleanup do staging",
        ]);
      }
      if (!(await this.releaseLease(reservation.run))) {
        return result("failed", reservation.run, reservation.lease, generated.composeHash, [
          "falha ao liberar a reserva de porta do staging",
        ]);
      }
      return result(promoted ? "promoted" : "healthy", reservation.run, reservation.lease, generated.composeHash, []);
    } catch {
      if (active && !cleanupDone) {
        await this.safeCleanup(active.run, active.lease, "falha interna");
        await this.releaseLease(active.run);
      }
      return result("failed", active?.run ?? null, active?.lease ?? null, generated.composeHash, ["falha interna no executor de staging"]);
    } finally {
      if (!alreadyHeld) await this.workerLock.release();
    }
  }

  private async releaseLease(run: NonNullable<StagingExecutionResult["run"]>): Promise<boolean> {
    if (!this.leaseRepository) return true;
    try {
      const released = await this.leaseRepository.release(run.projectId, run.runId);
      return released.ok;
    } catch {
      return false;
    }
  }

  private async safeCleanup(
    run: StagingExecutionResult["run"],
    lease: StagingExecutionResult["lease"],
    reason: string,
  ): Promise<{ ok: boolean; reason: string | null }> {
    if (!run) return { ok: true, reason: null };
    try {
      const cleanup = await this.runtime.cleanup({ run, lease, reason });
      return { ok: cleanup.ok, reason: cleanup.reason ?? null };
    } catch {
      return { ok: false, reason: "falha no cleanup do staging" };
    }
  }
}

function findInvalidEnvEntry(values: Record<string, string>): string | null {
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return key;
    if (typeof value !== "string" || value.includes("\n") || value.includes("\0") || value.includes("\r")) {
      return key;
    }
  }
  return null;
}

function detail(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/\s+/g, " ").trim().slice(0, 600)
    : "erro desconhecido";
}

function result(
  status: StagingExecutionResult["status"],
  run: StagingExecutionResult["run"],
  lease: StagingExecutionResult["lease"],
  composeHash: string | null,
  issues: string[],
): StagingExecutionResult {
  return { ok: status === "healthy" || status === "promoted", status, run, lease, composeHash, issues };
}
