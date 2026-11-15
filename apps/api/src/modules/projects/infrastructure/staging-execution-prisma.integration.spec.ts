import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaStagingRunRepository } from "./prisma-staging-run.repository";
import { PrismaStagingPortLeaseRepository } from "./prisma-staging-port-lease.repository";
import { StagingCapacityService } from "../application/staging-capacity.service";
import { StagingExecutionService } from "../application/staging-execution.service";
import { WorkerLock } from "./worker-lock";
import { planStaging } from "../domain/staging-planner";
import type {
  StagingExecutionRequest,
  StagingImageIdentityResult,
  StagingImageVerifier,
  StagingRuntimeAdapter,
  StagingRuntimeCleanupInput,
  StagingRuntimeHealthInput,
  StagingRuntimeStartInput,
} from "../domain/staging-execution";
import type { StagingHostMetricsReader } from "../domain/staging-context";
import type { StagingCapacityPolicy } from "../domain/staging-capacity";

const PRISMA_DIR = path.join(__dirname, "../../../../prisma");
const dbFileName = `.p1d-exec-${crypto.randomUUID()}.db`;
const dbPath = path.join(PRISMA_DIR, dbFileName);
const databaseUrl = `file:./${dbFileName}`;

class FakeHost implements StagingHostMetricsReader {
  snapshot = { availableCpu: 8, availableMemoryMb: 4096, freeDiskMb: 20_000 };
  async read() {
    return this.snapshot;
  }
}

const policy: StagingCapacityPolicy = {
  maxConcurrentEnvironments: 4,
  maxTtlMinutes: 60,
  productionReservedMemoryMb: 0,
  productionReservedCpu: 0,
  productionReservedDiskMb: 0,
  safetyMemoryMb: 0,
  safetyCpu: 0,
  safetyDiskMb: 0,
};

class FakeVerifier implements StagingImageVerifier {
  result: StagingImageIdentityResult = {
    ok: true,
    identityVerified: true,
    originAuthenticated: false,
    imageId: "sha256:" + "a".repeat(64),
    digest: null,
    issues: [],
  };
  calls = 0;
  async verify() {
    this.calls += 1;
    return this.result;
  }
}

class FakeRuntime implements StagingRuntimeAdapter {
  startCalls = 0;
  healthCalls = 0;
  cleanupCalls = 0;
  healthy = true;
  lastHttpHealth: StagingRuntimeHealthInput["httpHealth"] = null;
  async start(_input: StagingRuntimeStartInput) {
    this.startCalls += 1;
  }
  async health(input: StagingRuntimeHealthInput) {
    this.healthCalls += 1;
    this.lastHttpHealth = input.httpHealth ?? null;
    return this.healthy;
  }
  async cleanup(_input: StagingRuntimeCleanupInput) {
    this.cleanupCalls += 1;
    return { ok: true, reason: null };
  }
}

function plan(runId: string) {
  const result = planStaging({
    projectId: "project-exec-1",
    runId,
    config: {
      mode: "isolated",
      ttlMinutes: 30,
      app: { memoryMb: 256, cpu: 0.25, diskMb: 256, mounts: [] },
      env: [],
    },
    dependencies: [],
    production: { volumes: [], networks: [], databaseTargets: [], secretFingerprints: [] },
    host: {
      availableCpu: 8,
      availableMemoryMb: 4096,
      freeDiskMb: 20_000,
      activeEnvironments: 0,
      maxConcurrentEnvironments: 4,
      maxTtlMinutes: 60,
      portCandidates: [4500, 4501, 4502],
    },
  });
  if (!result.plan) throw new Error(JSON.stringify(result.issues));
  return result.plan;
}

function request(runId: string): StagingExecutionRequest {
  const value = plan(runId);
  return {
    plan: value,
    commitSha: "c".repeat(40),
    mode: "prebuilt",
    compose: {
      containerPort: 3000,
      pidsLimit: 128,
      imageReference: "korrelo-app:commit-cccccccccccc",
      healthcheck: null,
    },
    imageIdentity: {
      projectId: value.projectId,
      commitSha: "c".repeat(40),
      imageReference: "korrelo-app:commit-cccccccccccc",
      observed: { imageId: "", repoDigests: [], labels: {} },
    },
    deployJobId: "job-exec",
    portCandidates: [4500, 4501, 4502],
    ttlMinutes: 30,
    policy,
    app: { memoryMb: 256, cpu: 0.25, diskMb: 256 },
    dependencies: [],
  };
}

describe("StagingExecutionService com Prisma real (SQLite temporário)", () => {
  let prisma: PrismaClient;
  let runs: PrismaStagingRunRepository;
  let leases: PrismaStagingPortLeaseRepository;
  let host: FakeHost;
  let projectId: string;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousLockDir = process.env.KORRELO_LOCK_DIR;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    const prismaCli = require.resolve("prisma/build/index.js");
    execFileSync(process.execPath, [prismaCli, "db", "push", "--skip-generate"], {
      cwd: path.join(__dirname, "../../../.."),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    });
    prisma = new PrismaClient();
    await prisma.$connect();
    leases = new PrismaStagingPortLeaseRepository(prisma as never);
    host = new FakeHost();
    runs = new PrismaStagingRunRepository(prisma as never, new StagingCapacityService(leases, host), host);
    const project = await prisma.project.create({
      data: { id: "project-exec-1", name: "Exec Project", repoUrl: "https://example.com/exec.git" },
    });
    projectId = project.id;
    process.env.KORRELO_LOCK_DIR = path.join(PRISMA_DIR, `.p1d-lock-${crypto.randomUUID()}`);
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-journal`, { force: true });
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousLockDir === undefined) delete process.env.KORRELO_LOCK_DIR;
    else process.env.KORRELO_LOCK_DIR = previousLockDir;
  });

  beforeEach(async () => {
    await prisma.stagingRun.deleteMany({ where: { projectId } });
    await prisma.stagingPortLease.deleteMany({ where: { projectId } });
    await prisma.stagingCoordinator.deleteMany();
    host.snapshot = { availableCpu: 8, availableMemoryMb: 4096, freeDiskMb: 20_000 };
  });

  it("executa, aprova health e persiste StagingRun real", async () => {
    const runtime = new FakeRuntime();
    const verifier = new FakeVerifier();
    const service = new StagingExecutionService(runs, new WorkerLock(), verifier, runtime, true);
    const input = request("run-exec-ok");

    const result = await service.execute(input, { path: "/health", require2xx: true });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("healthy");
    expect(runtime.startCalls).toBe(1);
    expect(runtime.cleanupCalls).toBe(1);
    expect(runtime.lastHttpHealth).toEqual({ path: "/health", require2xx: true });
    const persisted = await prisma.stagingRun.findFirst({ where: { projectId, runId: "run-exec-ok" } });
    expect(persisted).not.toBeNull();
    expect(persisted?.imageId).toBe("sha256:" + "a".repeat(64));
    expect(persisted?.composeHash).toBe(result.composeHash);
  });

  it("health reprovado não promove e persiste a evidência", async () => {
    const runtime = new FakeRuntime();
    runtime.healthy = false;
    const service = new StagingExecutionService(runs, new WorkerLock(), new FakeVerifier(), runtime, true);
    const input = request("run-exec-fail");

    const result = await service.execute(input);

    expect(result.status).toBe("failed");
    expect(runtime.cleanupCalls).toBe(1);
    const persisted = await prisma.stagingRun.findFirst({ where: { projectId, runId: "run-exec-fail" } });
    expect(persisted).not.toBeNull();
  });

  it("capacidade insuficiente é bloqueada pelo repositório Prisma real", async () => {
    const runtime = new FakeRuntime();
    const service = new StagingExecutionService(runs, new WorkerLock(), new FakeVerifier(), runtime, true);
    host.snapshot = { availableCpu: 8, availableMemoryMb: 64, freeDiskMb: 20_000 };
    const input = request("run-exec-capacity");

    const result = await service.execute(input);

    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(runtime.startCalls).toBe(0);
    expect(result.issues.join(" ")).toContain("Memória insuficiente");
  });
});
