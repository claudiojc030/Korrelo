import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaStagingPortLeaseRepository } from "./prisma-staging-port-lease.repository";
import { StagingCapacityService } from "../application/staging-capacity.service";
import { StagingPortLeaseService } from "../application/staging-port-lease.service";
import { StagingLeaseRecoveryService } from "../application/staging-lease-recovery.service";
import type {
  StagingHostMetricsReader,
  StagingHostMetricsSnapshot,
  StagingPortProbe,
} from "../domain/staging-context";
import type { StagingDockerInventoryReader, StagingDockerInventorySnapshot } from "../domain/staging-docker-inventory";
import type { StagingCapacityPolicy } from "../domain/staging-capacity";

const PRISMA_DIR = path.join(__dirname, "../../../../prisma");
const dbFileName = `.p1b2-lease-${crypto.randomUUID()}.db`;
const dbPath = path.join(PRISMA_DIR, dbFileName);
const databaseUrl = `file:./${dbFileName}`;

class FakeHostMetrics implements StagingHostMetricsReader {
  snapshot: StagingHostMetricsSnapshot = { availableCpu: 8, availableMemoryMb: 4096, freeDiskMb: 20_000 };
  async read(): Promise<StagingHostMetricsSnapshot> {
    return this.snapshot;
  }
}

class FakePortProbe implements StagingPortProbe {
  unavailable: number[] = [];
  fail = false;
  async findUnavailable(ports: number[]): Promise<number[]> {
    if (this.fail) throw new Error("probe falhou");
    return this.unavailable.filter((port) => ports.includes(port));
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
  async inspect(): Promise<StagingDockerInventorySnapshot> {
    return this.snapshot;
  }
}

const policy: StagingCapacityPolicy = {
  maxConcurrentEnvironments: 10,
  maxTtlMinutes: 60,
  productionReservedMemoryMb: 256,
  productionReservedCpu: 0.25,
  productionReservedDiskMb: 512,
  safetyMemoryMb: 128,
  safetyCpu: 0.25,
  safetyDiskMb: 256,
};

const app = { memoryMb: 512, cpu: 0.5, diskMb: 1024 };

describe("P1B2 port lease and capacity", () => {
  let prisma: PrismaClient;
  let repository: PrismaStagingPortLeaseRepository;
  let service: StagingPortLeaseService;
  let capacity: StagingCapacityService;
  let host: FakeHostMetrics;
  let probe: FakePortProbe;
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
    repository = new PrismaStagingPortLeaseRepository(prisma as never);
    host = new FakeHostMetrics();
    probe = new FakePortProbe();
    capacity = new StagingCapacityService(repository, host);
    service = new StagingPortLeaseService(repository, capacity, probe);
    const project = await prisma.project.create({
      data: { name: "Lease Project", repoUrl: "https://example.com/lease.git" },
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
    await prisma.stagingPortLease.deleteMany({ where: { projectId } });
    host.snapshot = { availableCpu: 8, availableMemoryMb: 4096, freeDiskMb: 20_000 };
    probe.unavailable = [];
    probe.fail = false;
  });

  function request(runId: string, overrides: Partial<Parameters<StagingPortLeaseService["acquire"]>[0]> = {}) {
    return {
      projectId,
      runId,
      portCandidates: [4100, 4101],
      ttlMinutes: 30,
      app,
      dependencies: [],
      policy,
      ...overrides,
    };
  }

  it("adquire lease de porta e grava recursos", async () => {
    const result = await service.acquire(request("run-1"));

    expect(result.ok).toBe(true);
    expect(result.lease?.hostPort).toBe(4100);
    expect(result.lease?.memoryMb).toBe(512);
    expect(result.capacity?.ok).toBe(true);
    await expect(repository.findLive()).resolves.toHaveLength(1);
  });

  it("duas reservas concorrentes da mesma porta: apenas uma vence", async () => {
    const [a, b] = await Promise.all([
      service.acquire(request("run-a", { portCandidates: [4200] })),
      service.acquire(request("run-b", { portCandidates: [4200] })),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await repository.findLive()).toHaveLength(1);
  });

  it("duas reservas concorrentes usam portas diferentes", async () => {
    const [a, b] = await Promise.all([
      service.acquire(request("run-c", { portCandidates: [4210, 4211] })),
      service.acquire(request("run-d", { portCandidates: [4210, 4211] })),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(new Set([a.lease?.hostPort, b.lease?.hostPort]).size).toBe(2);
  });

  it("porta ocupada no host é ignorada", async () => {
    probe.unavailable = [4100];
    const result = await service.acquire(request("run-e"));

    expect(result.ok).toBe(true);
    expect(result.lease?.hostPort).toBe(4101);
  });

  it("capacidade insuficiente bloqueia antes de gravar lease", async () => {
    host.snapshot = { availableCpu: 0.1, availableMemoryMb: 100, freeDiskMb: 100 };
    const result = await service.acquire(request("run-f"));

    expect(result.ok).toBe(false);
    expect(result.lease).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["STAGING_CAPACITY_MEMORY", "STAGING_CAPACITY_CPU", "STAGING_CAPACITY_DISK"]),
    );
    await expect(repository.findLive()).resolves.toHaveLength(0);
  });

  it("lease expirado sem evidência é liberado para novo lease", async () => {
    const first = await service.acquire(request("run-g", { portCandidates: [4300], ttlMinutes: 1 }));
    expect(first.ok).toBe(true);
    await prisma.stagingPortLease.update({
      where: { id: first.lease!.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const recovery = new StagingLeaseRecoveryService(repository, new FakeInventory());
    const recovered = await recovery.recover();
    expect(recovered.expired).toContain("run-g");
    expect(await repository.findLive()).toHaveLength(0);
    const secondRecovery = await recovery.recover();
    expect(secondRecovery.inspected).toBe(0);

    const second = await service.acquire(request("run-h", { portCandidates: [4300] }));
    expect(second.ok).toBe(true);
    expect(second.lease?.hostPort).toBe(4300);
  });

  it("lease expirado com evidência vira conflito e não libera a porta", async () => {
    const first = await service.acquire(request("run-i", { portCandidates: [4310], ttlMinutes: 1 }));
    await prisma.stagingPortLease.update({
      where: { id: first.lease!.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const inventory = new FakeInventory();
    inventory.snapshot.publishedPorts = [4310];

    const recovery = new StagingLeaseRecoveryService(repository, inventory);
    const recovered = await recovery.recover();
    expect(recovered.conflicts).toContain("run-i");
    expect(await repository.findLive()).toHaveLength(1);

    const releaseWithoutForce = await service.release(projectId, "run-i");
    expect(releaseWithoutForce.ok).toBe(false);
    const forced = await service.release(projectId, "run-i", { allowConflict: true });
    expect(forced.ok).toBe(true);
    expect(await repository.findLive()).toHaveLength(0);
  });

  it("inventário incompleto não altera nenhuma reserva", async () => {
    const first = await service.acquire(request("run-j", { portCandidates: [4320], ttlMinutes: 1 }));
    await prisma.stagingPortLease.update({
      where: { id: first.lease!.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const inventory = new FakeInventory();
    inventory.snapshot.complete = false;
    inventory.snapshot.error = "docker incompleto";

    const recovery = new StagingLeaseRecoveryService(repository, inventory);
    const recovered = await recovery.recover();

    expect(recovered.ok).toBe(false);
    expect(recovered.issues[0].code).toBe("STAGING_RECOVERY_INVENTORY_INCOMPLETE");
    expect(await repository.findLive()).toHaveLength(1);
  });

  it("falha do banco na aquisição retorna erro estruturado", async () => {
    const failing = new StagingPortLeaseService(
      {
        findLive: async () => [],
        create: async () => {
          throw new Error("db offline");
        },
      } as never,
      capacity,
      probe,
    );

    const result = await failing.acquire(request("run-k"));
    expect(result.ok).toBe(false);
    expect(result.issues[0].code).toBe("STAGING_LEASE_DB_ERROR");
  });

  it("falha da sonda bloqueia sem gravar", async () => {
    probe.fail = true;
    const result = await service.acquire(request("run-l"));
    expect(result.ok).toBe(false);
    expect(result.issues[0].code).toBe("STAGING_LEASE_PORT_PROBE_UNAVAILABLE");
    expect(await repository.findLive()).toHaveLength(0);
  });
});
