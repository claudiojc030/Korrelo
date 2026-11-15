import { StagingCapacityService } from "./staging-capacity.service";
import type { StagingPortLeaseRepository, StagingPortLease } from "../domain/staging-lease";
import type { StagingHostMetricsReader } from "../domain/staging-context";
import type { StagingCapacityPolicy } from "../domain/staging-capacity";

class FakeLeaseRepository implements StagingPortLeaseRepository {
  leases: StagingPortLease[] = [];
  async create(): Promise<StagingPortLease> {
    throw new Error("not used");
  }
  async findLive(): Promise<StagingPortLease[]> {
    return this.leases;
  }
  async findExpired(): Promise<StagingPortLease[]> {
    return [];
  }
  async findByProjectAndRun(): Promise<StagingPortLease | null> {
    return null;
  }
  async markExpired(): Promise<StagingPortLease | null> {
    return null;
  }
  async markConflict(): Promise<StagingPortLease | null> {
    return null;
  }
  async release(): Promise<{ ok: boolean; lease: StagingPortLease | null; reason: string | null }> {
    return { ok: true, lease: null, reason: null };
  }
}

class FakeHost implements StagingHostMetricsReader {
  snapshot = { availableCpu: 4, availableMemoryMb: 2048, freeDiskMb: 10000 };
  async read() {
    return this.snapshot;
  }
}

const policy: StagingCapacityPolicy = {
  maxConcurrentEnvironments: 2,
  maxTtlMinutes: 60,
  productionReservedMemoryMb: 256,
  productionReservedCpu: 0.25,
  productionReservedDiskMb: 512,
  safetyMemoryMb: 128,
  safetyCpu: 0.25,
  safetyDiskMb: 256,
};

function lease(overrides: Partial<StagingPortLease> = {}): StagingPortLease {
  return {
    id: "lease-1",
    projectId: "p1",
    runId: "run-1",
    hostPort: 4100,
    status: "active",
    expiresAt: new Date(Date.now() + 60_000),
    memoryMb: 512,
    cpu: 0.5,
    diskMb: 1024,
    ownerId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    releasedAt: null,
    ...overrides,
  };
}

describe("StagingCapacityService", () => {
  it("considera reservas existentes e rejeita overcommit", async () => {
    const repo = new FakeLeaseRepository();
    repo.leases = [lease({ memoryMb: 1500, cpu: 1, diskMb: 9000 })];
    const capacity = new StagingCapacityService(repo, new FakeHost());

    const result = await capacity.evaluate({
      app: { memoryMb: 512, cpu: 0.5, diskMb: 1024 },
      dependencies: [],
      ttlMinutes: 30,
      policy,
    });

    expect(result.ok).toBe(false);
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("STAGING_CAPACITY_MEMORY");
    expect(codes).toContain("STAGING_CAPACITY_DISK");
  });

  it("rejeita limite de ambientes simultâneos", async () => {
    const repo = new FakeLeaseRepository();
    repo.leases = [lease(), lease({ id: "lease-2", runId: "run-2", hostPort: 4101 })];
    const capacity = new StagingCapacityService(repo, new FakeHost());

    const result = await capacity.evaluate({
      app: { memoryMb: 128, cpu: 0.1, diskMb: 128 },
      dependencies: [],
      ttlMinutes: 30,
      policy: { ...policy, maxConcurrentEnvironments: 2 },
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("STAGING_CAPACITY_CONCURRENCY");
  });

  it("host incompleto bloqueia sem inventar recursos", async () => {
    const host = new FakeHost();
    host.snapshot = { availableCpu: 0, availableMemoryMb: 0, freeDiskMb: 0 };
    const capacity = new StagingCapacityService(new FakeLeaseRepository(), host);

    const result = await capacity.evaluate({
      app: { memoryMb: 128, cpu: 0.1, diskMb: 128 },
      dependencies: [],
      ttlMinutes: 30,
      policy,
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("STAGING_CAPACITY_MEMORY");
  });

  it("TTL acima do máximo é rejeitado", async () => {
    const capacity = new StagingCapacityService(new FakeLeaseRepository(), new FakeHost());

    const result = await capacity.evaluate({
      app: { memoryMb: 128, cpu: 0.1, diskMb: 128 },
      dependencies: [],
      ttlMinutes: 61,
      policy,
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("STAGING_CAPACITY_TTL_INVALID");
  });
});
