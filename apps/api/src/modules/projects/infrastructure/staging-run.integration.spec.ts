import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaStagingRunRepository } from "./prisma-staging-run.repository";
import { PrismaStagingPortLeaseRepository } from "./prisma-staging-port-lease.repository";
import { StagingCapacityService } from "../application/staging-capacity.service";
import { StagingRunRecoveryService } from "../application/staging-run-recovery.service";
import { hashStagingPlan, stableStringify } from "../domain/staging-plan-hash";
import { verifyStagingRunOwnership } from "../domain/staging-run";
import type { StagingHostMetricsReader } from "../domain/staging-context";
import type { StagingDockerInventoryReader, StagingDockerInventorySnapshot } from "../domain/staging-docker-inventory";
import type { StagingCapacityPolicy } from "../domain/staging-capacity";

const PRISMA_DIR = path.join(__dirname, "../../../../prisma");
const dbFileName = `.p1b3-run-${crypto.randomUUID()}.db`;
const dbPath = path.join(PRISMA_DIR, dbFileName);
const databaseUrl = `file:./${dbFileName}`;

class FakeHost implements StagingHostMetricsReader {
  snapshot = { availableCpu: 8, availableMemoryMb: 4096, freeDiskMb: 20_000 };
  async read() {
    return this.snapshot;
  }
}

class FakeInventory implements StagingDockerInventoryReader {
  snapshot: StagingDockerInventorySnapshot = {
    complete: true,
    containers: [],
    networks: [],
    volumes: [],
    publishedPorts: [],
    error: null,
  };
  async inspect() {
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

const app = { memoryMb: 512, cpu: 0.5, diskMb: 1024 };

describe("P1B3 atomic StagingRun", () => {
  let prisma: PrismaClient;
  let runs: PrismaStagingRunRepository;
  let leases: PrismaStagingPortLeaseRepository;
  let host: FakeHost;
  let projectId: string;
  const previousDatabaseUrl = process.env.DATABASE_URL;

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
    const capacity = new StagingCapacityService(leases, host);
    runs = new PrismaStagingRunRepository(prisma as never, capacity, host);
    const project = await prisma.project.create({
      data: { name: "Run Project", repoUrl: "https://example.com/run.git" },
    });
    projectId = project.id;
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-journal`, { force: true });
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  beforeEach(async () => {
    await prisma.stagingRun.deleteMany({ where: { projectId } });
    await prisma.stagingPortLease.deleteMany({ where: { projectId } });
    await prisma.stagingCoordinator.deleteMany();
    host.snapshot = { availableCpu: 8, availableMemoryMb: 4096, freeDiskMb: 20_000 };
  });

  function input(runId: string, overrides: Partial<Parameters<PrismaStagingRunRepository["reserve"]>[0]> = {}) {
    return {
      projectId,
      deployJobId: "job-1",
      runId,
      composeProject: `korrelo-stg-${runId}`,
      planHash: "a".repeat(64),
      composeHash: "b".repeat(64),
      imageReference: "korrelo-app:commit-abc",
      app,
      dependencies: [],
      portCandidates: [4400, 4401],
      ttlMinutes: 30,
      policy,
      ...overrides,
    };
  }

  it("reserva lease e StagingRun na mesma transação", async () => {
    const result = await runs.reserve(input("run-1"));

    expect(result.ok).toBe(true);
    expect(result.run?.status).toBe("reserved");
    expect(result.run?.leaseId).toBe(result.lease?.id);
    expect(result.run?.memoryMb).toBe(512);
    await expect(prisma.stagingRun.count({ where: { projectId } })).resolves.toBe(1);
    await expect(prisma.stagingPortLease.count({ where: { projectId } })).resolves.toBe(1);
  });

  it("duas reservas concorrentes com portas diferentes e capacidade para uma só", async () => {
    host.snapshot = { availableCpu: 8, availableMemoryMb: 700, freeDiskMb: 20_000 };

    const [a, b] = await Promise.all([
      runs.reserve(input("run-a", { portCandidates: [4410] })),
      runs.reserve(input("run-b", { portCandidates: [4411] })),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const failed = a.ok ? b : a;
    expect(failed.issues.map((issue) => issue.code)).toContain("STAGING_CAPACITY_MEMORY");
    await expect(prisma.stagingRun.count({ where: { projectId } })).resolves.toBe(1);
  });

  it("duas reservas concorrentes da mesma porta: apenas uma vence", async () => {
    const [a, b] = await Promise.all([
      runs.reserve(input("run-c", { portCandidates: [4420] })),
      runs.reserve(input("run-d", { portCandidates: [4420] })),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    await expect(prisma.stagingPortLease.count({ where: { projectId } })).resolves.toBe(1);
  });

  it("falha ao criar run reverte o lease na mesma transação", async () => {
    const first = await runs.reserve(input("run-e", { portCandidates: [4430] }));
    expect(first.ok).toBe(true);

    const duplicate = await runs.reserve(input("run-e", { portCandidates: [4431] }));

    expect(duplicate.ok).toBe(false);
    await expect(prisma.stagingPortLease.count({ where: { projectId } })).resolves.toBe(1);
    await expect(prisma.stagingRun.count({ where: { projectId } })).resolves.toBe(1);
  });

  it("projeto inexistente falha e não deixa lease", async () => {
    const result = await runs.reserve(input("run-f", { projectId: "missing-project", portCandidates: [4440] }));

    expect(result.ok).toBe(false);
    await expect(prisma.stagingPortLease.count()).resolves.toBe(0);
  });

  it("recuperação sem evidência expira run e lease; com evidência marca conflito", async () => {
    const first = await runs.reserve(input("run-g", { portCandidates: [4450] }));
    await prisma.stagingRun.update({
      where: { id: first.run!.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await prisma.stagingPortLease.update({
      where: { id: first.lease!.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const inventory = new FakeInventory();
    const recovery = new StagingRunRecoveryService(runs, leases, inventory);
    const clean = await recovery.recover();
    expect(clean.expired).toContain("run-g");
    expect((await prisma.stagingRun.findUnique({ where: { id: first.run!.id } }))?.status).toBe("expired");
    expect(await prisma.stagingPortLease.count({ where: { projectId, portKey: { not: null } } })).toBe(0);

    const second = await runs.reserve(input("run-h", { portCandidates: [4460] }));
    await prisma.stagingRun.update({
      where: { id: second.run!.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await prisma.stagingPortLease.update({
      where: { id: second.lease!.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    inventory.snapshot.publishedPorts = [4460];
    const conflict = await recovery.recover();
    expect(conflict.conflicts).toContain("run-h");
    expect((await prisma.stagingRun.findUnique({ where: { id: second.run!.id } }))?.status).toBe("conflict");
    expect((await prisma.stagingPortLease.findUnique({ where: { id: second.lease!.id } }))?.status).toBe("conflict");
    const secondPass = await recovery.recover();
    expect(secondPass.inspected).toBe(0);
  });

  it("inventário incompleto não altera run/lease", async () => {
    const first = await runs.reserve(input("run-i", { portCandidates: [4470] }));
    await prisma.stagingRun.update({ where: { id: first.run!.id }, data: { expiresAt: new Date(0) } });
    const inventory = new FakeInventory();
    inventory.snapshot.complete = false;
    inventory.snapshot.error = "incompleto";

    const result = await new StagingRunRecoveryService(runs, leases, inventory).recover();

    expect(result.ok).toBe(false);
    expect((await prisma.stagingRun.findUnique({ where: { id: first.run!.id } }))?.status).toBe("reserved");
    expect(await prisma.stagingPortLease.count({ where: { projectId, portKey: { not: null } } })).toBe(1);
    expect(result.orphans).toEqual([]);
  });

  it("detecta recurso órfão conhecido sem remover nada", async () => {
    const inventory = new FakeInventory();
    inventory.snapshot.containers = [
      {
        id: "orphan-id",
        name: "orphan-container",
        state: "running",
        image: "img",
        labels: {
          "korrelo.projectId": projectId,
          "korrelo.stagingRunId": "orphan-run",
          "korrelo.ephemeral": "true",
        },
        publishedPorts: [],
        composeProject: null,
      },
    ];

    const result = await new StagingRunRecoveryService(runs, leases, inventory).recover();

    expect(result.orphans).toContain("container:orphan-container");
  });

  it("recuperação não sobrescreve renovação concorrente", async () => {
    const first = await runs.reserve(input("run-renew", { portCandidates: [4490] }));
    const now = new Date();
    await prisma.stagingRun.update({
      where: { id: first.run!.id },
      data: { expiresAt: new Date(now.getTime() + 60_000) },
    });
    await prisma.stagingPortLease.update({
      where: { id: first.lease!.id },
      data: { expiresAt: new Date(now.getTime() + 60_000) },
    });

    const recovered = await runs.recoverRun({
      projectId,
      runId: "run-renew",
      now,
      outcome: "expired",
    });

    expect(recovered.ok).toBe(false);
    expect(recovered.reason).toBe("renewed");
    expect((await prisma.stagingRun.findUnique({ where: { id: first.run!.id } }))?.status).toBe("reserved");
    expect((await prisma.stagingPortLease.findUnique({ where: { id: first.lease!.id } }))?.status).toBe("active");
  });

  it("hash do plano é determinístico e não contém segredos", () => {
    const plan = {
      mode: "isolated" as const,
      projectId,
      runId: "run-hash",
      composeProject: "korrelo-stg-run-hash",
      ttlMinutes: 30,
      network: { name: "net", egressEnabled: false, sharedNetwork: false as const, publicDomain: null as null },
      app: { containerName: "app", hostPort: 1000, hostBind: "127.0.0.1:1000", memoryMb: 1, cpu: 1, diskMb: 1, mounts: [] },
      dependencies: [],
      volumes: [],
      env: [],
      resources: { memoryMb: 1, cpu: 1, diskMb: 1, dependencyCount: 0 },
      security: {
        sharedNetworkUsed: false as const,
        productionVolumeUsed: false as const,
        productionCredentialDetected: false as const,
        dockerSocketMounted: false as const,
        privileged: false as const,
        hostNetwork: false as const,
      },
      warnings: ["x"],
      requiresAtomicPortReservation: true as const,
    };
    const first = hashStagingPlan(plan);
    const second = hashStagingPlan({ ...plan, warnings: ["changed"] });
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("ownership exige registro e labels compatíveis", async () => {
    const first = await runs.reserve(input("run-owner", { portCandidates: [4480] }));
    const run = first.run!;
    const ok = verifyStagingRunOwnership(run, {
      kind: "container",
      name: "container",
      labels: {
        "korrelo.projectId": projectId,
        "korrelo.stagingRunId": "run-owner",
        "korrelo.deployJobId": "job-1",
        "korrelo.ephemeral": "true",
        "com.docker.compose.project": "korrelo-stg-run-owner",
      },
      composeProject: "korrelo-stg-run-owner",
    });
    expect(ok.ok).toBe(true);
    const mismatch = verifyStagingRunOwnership(run, {
      kind: "container",
      name: "container",
      labels: {
        "korrelo.projectId": "other",
        "korrelo.stagingRunId": "run-owner",
        "korrelo.ephemeral": "true",
        "com.docker.compose.project": "korrelo-stg-run-owner",
      },
      composeProject: "korrelo-stg-run-owner",
    });
    expect(mismatch.ok).toBe(false);
  });
});
