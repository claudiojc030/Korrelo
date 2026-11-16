import { StagingExecutionService } from "./staging-execution.service";
import { planStaging } from "../domain/staging-planner";
import {
  verifyPrebuiltImageIdentity,
  type StagingExecutionRequest,
  type StagingImageIdentityResult,
  type StagingImageVerifier,
  type StagingRuntimeAdapter,
} from "../domain/staging-execution";
import type { StagingRunRepository } from "../domain/staging-run";

class FakeLock {
  held = false;
  acquireCalls = 0;
  releaseCalls = 0;
  async acquire() {
    this.acquireCalls += 1;
    if (this.held) return false;
    this.held = true;
    return true;
  }
  async release() {
    this.releaseCalls += 1;
    this.held = false;
  }
  isHeldByMe() {
    return this.held;
  }
}

class FakeRuntime implements StagingRuntimeAdapter {
  startCalls = 0;
  healthCalls = 0;
  promoteCalls = 0;
  cleanupCalls = 0;
  healthy = true;
  failStart = false;
  failCleanup = false;
  lastDocument: any = null;
  async start(input: any) {
    this.startCalls += 1;
    this.lastDocument = input.document;
    if (this.failStart) throw new Error("start falhou");
  }
  async health() {
    this.healthCalls += 1;
    return this.healthy;
  }
  async promote() {
    this.promoteCalls += 1;
  }
  async cleanup() {
    this.cleanupCalls += 1;
    return { ok: !this.failCleanup, reason: this.failCleanup ? "cleanup falhou" : null };
  }
}

class FakeImageVerifier implements StagingImageVerifier {
  calls = 0;
  fail = false;
  async verify(input: Parameters<StagingImageVerifier["verify"]>[0]): Promise<StagingImageIdentityResult> {
    this.calls += 1;
    if (this.fail) {
      return {
        ok: false,
        identityVerified: false,
        originAuthenticated: false,
        imageId: null,
        digest: null,
        issues: ["imagem inválida"],
      };
    }
    return verifyPrebuiltImageIdentity(input);
  }
}

function plan() {
  const result = planStaging({
    projectId: "project-exec",
    runId: "run-exec",
    config: {
      mode: "isolated",
      ttlMinutes: 30,
      app: { memoryMb: 512, cpu: 0.5, diskMb: 1024, mounts: [] },
      env: [],
    },
    dependencies: [],
    production: { volumes: [], networks: [], databaseTargets: [], secretFingerprints: [] },
    host: {
      availableCpu: 4,
      availableMemoryMb: 4096,
      freeDiskMb: 10000,
      activeEnvironments: 0,
      maxConcurrentEnvironments: 2,
      maxTtlMinutes: 120,
      portCandidates: [4600],
    },
  });
  if (!result.plan) throw new Error("plano de teste inválido");
  return result.plan;
}

function makeInput(overrides: Partial<StagingExecutionRequest> = {}): StagingExecutionRequest {
  const p = plan();
  return {
    plan: p,
    commitSha: "a".repeat(40),
    mode: "prebuilt",
    compose: {
      containerPort: 3000,
      pidsLimit: 128,
      imageReference: "korrelo-app:commit-aaaaaaaaaaaa",
    },
    imageIdentity: {
      projectId: p.projectId,
      commitSha: "a".repeat(40),
      imageReference: "korrelo-app:commit-aaaaaaaaaaaa",
      observed: {
        imageId: "sha256:" + "a".repeat(64),
        repoDigests: ["korrelo-app@sha256:" + "b".repeat(64)],
        labels: { "korrelo.projectId": p.projectId, "korrelo.commitSha": "a".repeat(40) },
      },
    },
    deployJobId: "job-exec",
    portCandidates: [4600],
    ttlMinutes: 30,
    policy: {
      maxConcurrentEnvironments: 2,
      maxTtlMinutes: 120,
      productionReservedMemoryMb: 0,
      productionReservedCpu: 0,
      productionReservedDiskMb: 0,
      safetyMemoryMb: 0,
      safetyCpu: 0,
      safetyDiskMb: 0,
    },
    app: { memoryMb: 512, cpu: 0.5, diskMb: 1024 },
    dependencies: [],
    ...overrides,
  };
}

function runRepo() {
  const calls: any[] = [];
  const repository: StagingRunRepository = {
    async reserve(input) {
      calls.push(input);
      return {
        ok: true,
        run: {
          id: "run-id",
          projectId: input.projectId,
          deployJobId: input.deployJobId ?? null,
          runId: input.runId,
          composeProject: input.composeProject,
          status: "reserved",
          planHash: input.planHash,
          composeHash: input.composeHash,
          imageReference: input.imageReference ?? null,
          imageId: input.imageId ?? null,
          imageDigest: input.imageDigest ?? null,
          memoryMb: 512,
          cpu: 0.5,
          diskMb: 1024,
          leaseId: "lease-id",
          networkName: input.networkName ?? null,
          volumePrefix: input.volumePrefix ?? null,
          ownerId: input.ownerId ?? null,
          cleanupState: "none",
          createdAt: new Date(),
          updatedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        },
        lease: {
          id: "lease-id",
          projectId: input.projectId,
          runId: input.runId,
          hostPort: 4600,
          status: "active",
          expiresAt: new Date(Date.now() + 60_000),
          memoryMb: 512,
          cpu: 0.5,
          diskMb: 1024,
          ownerId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          releasedAt: null,
        },
        issues: [],
        capacity: null,
      };
    },
    async findByProjectAndRun() { return null; },
    async findExpired() { return []; },
    async recoverRun() { return { ok: false, run: null, lease: null, reason: "not_found" as const }; },
  };
  return { repository, calls };
}

describe("StagingExecutionService", () => {
  it("fica desabilitado por padrão e não reserva nada", async () => {
    const repo = runRepo();
    const runtime = new FakeRuntime();
    const service = new StagingExecutionService(repo.repository, new FakeLock() as any, new FakeImageVerifier(), runtime, false);

    const result = await service.execute(makeInput());

    expect(result.status).toBe("disabled");
    expect(repo.calls).toHaveLength(0);
    expect(runtime.startCalls).toBe(0);
  });

  it("prebuilt válido reserva, executa, promove após health e limpa", async () => {
    const repo = runRepo();
    const lock = new FakeLock();
    const verifier = new FakeImageVerifier();
    const runtime = new FakeRuntime();
    const service = new StagingExecutionService(repo.repository, lock as any, verifier, runtime, true);

    const result = await service.execute(makeInput());

    expect(result.ok).toBe(true);
    expect(result.status).toBe("promoted");
    expect(verifier.calls).toBe(1);
    expect(repo.calls).toHaveLength(1);
    expect(runtime.startCalls).toBe(1);
    expect(runtime.healthCalls).toBe(1);
    expect(runtime.promoteCalls).toBe(1);
    expect(runtime.cleanupCalls).toBe(1);
    expect(runtime.lastDocument).not.toHaveProperty("planHash");
    expect(lock.releaseCalls).toBe(1);
  });

  it("health reprovado não promove e faz cleanup", async () => {
    const repo = runRepo();
    const runtime = new FakeRuntime();
    runtime.healthy = false;
    const service = new StagingExecutionService(repo.repository, new FakeLock() as any, new FakeImageVerifier(), runtime, true);

    const result = await service.execute(makeInput());

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(runtime.healthCalls).toBe(1);
    expect(runtime.promoteCalls).toBe(0);
    expect(runtime.cleanupCalls).toBe(1);
  });

  it("falha de capacidade bloqueia antes do runtime", async () => {
    const repo = runRepo();
    const runtime = new FakeRuntime();
    repo.repository.reserve = async () => ({
      ok: false,
      run: null,
      lease: null,
      issues: [{ code: "STAGING_CAPACITY_MEMORY", field: "memoryMb", message: "sem memória" }],
      capacity: null,
    });
    const service = new StagingExecutionService(repo.repository, new FakeLock() as any, new FakeImageVerifier(), runtime, true);

    const result = await service.execute(makeInput());

    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(runtime.startCalls).toBe(0);
  });

  it("lock ocupado bloqueia sem chamar o repositório", async () => {
    const repo = runRepo();
    const lock = new FakeLock();
    lock.held = false;
    lock.acquire = async () => false;
    const service = new StagingExecutionService(repo.repository, lock as any, new FakeImageVerifier(), new FakeRuntime(), true);

    const result = await service.execute(makeInput());

    expect(result.ok).toBe(false);
    expect(repo.calls).toHaveLength(0);
    expect(result.status).toBe("blocked");
  });

  it("identidade de imagem inválida bloqueia antes da reserva", async () => {
    const repo = runRepo();
    const verifier = new FakeImageVerifier();
    verifier.fail = true;
    const service = new StagingExecutionService(repo.repository, new FakeLock() as any, verifier, new FakeRuntime(), true);

    const result = await service.execute(makeInput());

    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(repo.calls).toHaveLength(0);
  });

  it("falha ao iniciar runtime faz cleanup e libera o lock", async () => {
    const repo = runRepo();
    const lock = new FakeLock();
    const runtime = new FakeRuntime();
    runtime.failStart = true;
    const service = new StagingExecutionService(repo.repository, lock as any, new FakeImageVerifier(), runtime, true);

    const result = await service.execute(makeInput());

    expect(result.status).toBe("failed");
    expect(runtime.startCalls).toBe(1);
    expect(runtime.cleanupCalls).toBe(1);
    expect(lock.releaseCalls).toBe(1);
    expect(lock.held).toBe(false);
  });

  it("falha no cleanup retorna failed e preserva a evidência", async () => {
    const repo = runRepo();
    const runtime = new FakeRuntime();
    runtime.failCleanup = true;
    const service = new StagingExecutionService(repo.repository, new FakeLock() as any, new FakeImageVerifier(), runtime, true);

    const result = await service.execute(makeInput());

    expect(result.status).toBe("failed");
    expect(result.run).not.toBeNull();
    expect(result.issues.join(" ")).toContain("cleanup");
  });

  it("porta reservada divergente do plano bloqueia antes do runtime", async () => {
    const repo = runRepo();
    const original = repo.repository.reserve.bind(repo.repository);
    repo.repository.reserve = async (input) => {
      const reservation = await original(input);
      if (reservation.lease) reservation.lease.hostPort = 4601;
      return reservation;
    };
    const runtime = new FakeRuntime();
    const service = new StagingExecutionService(repo.repository, new FakeLock() as any, new FakeImageVerifier(), runtime, true);

    const result = await service.execute(makeInput());

    expect(result.status).toBe("blocked");
    expect(result.issues.join(" ")).toContain("porta");
    expect(runtime.startCalls).toBe(0);
    expect(runtime.cleanupCalls).toBe(1);
  });

  it("modo prebuilt recusa tag latest antes da reserva", async () => {
    const repo = runRepo();
    const runtime = new FakeRuntime();
    const service = new StagingExecutionService(repo.repository, new FakeLock() as any, new FakeImageVerifier(), runtime, true);
    const input = makeInput();
    input.compose.imageReference = "korrelo-app:latest";
    input.imageIdentity = { ...input.imageIdentity!, imageReference: "korrelo-app:latest" };

    const result = await service.execute(input);

    expect(result.status).toBe("blocked");
    expect(repo.calls).toHaveLength(0);
    expect(runtime.startCalls).toBe(0);
  });
});

describe("verifyPrebuiltImageIdentity", () => {
  const base = {
    projectId: "project",
    commitSha: "a".repeat(40),
    imageReference: "repo/app:commit-aaaaaaaaaaaa",
    observed: {
      imageId: "sha256:" + "b".repeat(64),
      repoDigests: ["repo/app@sha256:" + "c".repeat(64)],
      labels: { "korrelo.projectId": "project", "korrelo.commitSha": "a".repeat(40) },
      architecture: "amd64",
      os: "linux",
    },
  };

  it("aceita imagem com image ID e labels de projeto/commit", () => {
    const result = verifyPrebuiltImageIdentity(base);
    expect(result.ok).toBe(true);
    expect(result.identityVerified).toBe(true);
    expect(result.originAuthenticated).toBe(false);
  });

  it("aceita alias de projeto derivado do nome, além do UUID", () => {
    const aliasBase = {
      ...base,
      projectId: "uuid-do-projeto",
      projectAliases: ["mesatta"],
      observed: {
        ...base.observed,
        labels: { ...base.observed.labels, "korrelo.projectId": "mesatta" },
      },
    };
    expect(verifyPrebuiltImageIdentity(aliasBase).ok).toBe(true);
    expect(
      verifyPrebuiltImageIdentity({
        ...aliasBase,
        observed: {
          ...aliasBase.observed,
          labels: { ...aliasBase.observed.labels, "korrelo.projectId": "outro" },
        },
      }).ok,
    ).toBe(false);
  });

  it("recusa arquitetura ou SO divergente quando exigidos", () => {
    expect(
      verifyPrebuiltImageIdentity({ ...base, expectedOs: "linux", expectedArchitecture: "amd64" }).ok,
    ).toBe(true);
    expect(verifyPrebuiltImageIdentity({ ...base, expectedArchitecture: "arm64" }).ok).toBe(false);
    expect(verifyPrebuiltImageIdentity({ ...base, expectedOs: "windows" }).ok).toBe(false);
  });

  it("recusa latest, labels divergentes e image ID ausente", () => {
    expect(verifyPrebuiltImageIdentity({ ...base, imageReference: "repo/app:latest" }).ok).toBe(false);
    expect(verifyPrebuiltImageIdentity({ ...base, observed: { ...base.observed, labels: {} } }).ok).toBe(false);
    expect(verifyPrebuiltImageIdentity({ ...base, observed: { ...base.observed, imageId: "" } }).ok).toBe(false);
  });
});
