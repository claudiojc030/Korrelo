import { StagingRunRecoveryService } from "./staging-run-recovery.service";
import type { RecoverStagingRunInput, StagingRun, StagingRunRepository } from "../domain/staging-run";
import type { StagingPortLease, StagingPortLeaseRepository } from "../domain/staging-lease";
import type {
  StagingDockerInventoryReader,
  StagingDockerInventorySnapshot,
} from "../domain/staging-docker-inventory";

const NOW = new Date("2026-11-16T12:00:00.000Z");
const past = new Date(NOW.getTime() - 60 * 60 * 1000);

function run(overrides: Partial<StagingRun> = {}): StagingRun {
  return {
    id: "run-id",
    projectId: "proj-1",
    deployJobId: null,
    runId: "run-1",
    composeProject: "korrelo-stg-run-1",
    status: "running",
    planHash: "plan",
    composeHash: "compose",
    imageReference: "img:1",
    imageId: null,
    imageDigest: null,
    memoryMb: 1024,
    cpu: 0.5,
    diskMb: 1024,
    leaseId: "lease-1",
    networkName: "korrelo-stg-run-1",
    volumePrefix: "korrelo-stg-run-1",
    ownerId: null,
    cleanupState: "none",
    createdAt: past,
    updatedAt: past,
    expiresAt: past,
    ...overrides,
  };
}

function lease(overrides: Partial<StagingPortLease> = {}): StagingPortLease {
  return {
    id: "lease-1",
    projectId: "proj-1",
    runId: "run-1",
    hostPort: 19000,
    status: "active",
    expiresAt: past,
    memoryMb: 1024,
    cpu: 0.5,
    diskMb: 1024,
    ownerId: null,
    createdAt: past,
    updatedAt: past,
    releasedAt: null,
    ...overrides,
  };
}

function inventory(overrides: Partial<StagingDockerInventorySnapshot> = {}): StagingDockerInventoryReader {
  const snapshot: StagingDockerInventorySnapshot = {
    complete: true,
    containers: [],
    networks: [],
    volumes: [],
    publishedPorts: [],
    error: null,
    ...overrides,
  };
  return { inspect: async () => snapshot };
}

function runRepository(expired: StagingRun[], existing: Record<string, StagingRun> = {}) {
  const recoveries: RecoverStagingRunInput[] = [];
  const repository: StagingRunRepository = {
    reserve: jest.fn(),
    findByProjectAndRun: async (projectId, runId) => existing[`${projectId}:${runId}`] ?? null,
    findExpired: async () => expired,
    recoverRun: async (input) => {
      recoveries.push(input);
      return { ok: true, run: null, lease: null, reason: null };
    },
  };
  return { repository, recoveries };
}

function leaseRepository(current: StagingPortLease | null) {
  const leaseRepo: StagingPortLeaseRepository = {
    create: jest.fn(),
    findLive: async () => [],
    findExpired: async () => [],
    findByProjectAndRun: async () => current,
    markExpired: jest.fn(),
    markConflict: jest.fn(),
    release: jest.fn(),
  };
  return leaseRepo;
}

describe("StagingRunRecoveryService — volumes sem labels", () => {
  it("volume anônimo (labels vazias) não invalida o inventário nem vira conflito", async () => {
    const runs = runRepository([run()]);
    const service = new StagingRunRecoveryService(
      runs.repository,
      leaseRepository(lease()),
      inventory({
        volumes: [
          { name: "anon-configdb", labels: {} },
          { name: "outro-projeto-data", labels: { "korrelo.projectId": "proj-outro", "korrelo.stagingRunId": "run-outro" } },
        ],
      }),
    );

    const result = await service.recover({ now: NOW });

    expect(result.ok).toBe(true);
    expect(result.inspected).toBe(1);
    expect(result.expired).toEqual(["run-1"]);
    expect(result.conflicts).toEqual([]);
    expect(runs.recoveries).toHaveLength(1);
    expect(runs.recoveries[0]).toMatchObject({ projectId: "proj-1", runId: "run-1", outcome: "expired" });
  });

  it("volume de outro projeto é listado como órfão, nunca removido", async () => {
    const runs = runRepository([]);
    const service = new StagingRunRecoveryService(
      runs.repository,
      leaseRepository(null),
      inventory({
        volumes: [
          { name: "do-outro", labels: { "korrelo.projectId": "proj-outro", "korrelo.stagingRunId": "run-outro" } },
          { name: "sem-labels", labels: {} },
        ],
      }),
    );

    const result = await service.recover({ now: NOW });

    expect(result.ok).toBe(true);
    expect(result.orphans).toContain("volume:do-outro");
    expect(result.orphans).not.toContain("volume:sem-labels");
    // A recuperação não expõe nem chama remoção de recursos.
    expect(Object.keys(runs.repository)).not.toContain("remove");
    expect(Object.keys(runs.repository)).not.toContain("deleteByProject");
  });

  it("container com labels do run continua marcando conflito", async () => {
    const runs = runRepository([run()]);
    const service = new StagingRunRecoveryService(
      runs.repository,
      leaseRepository(lease()),
      inventory({
        containers: [
          {
            id: "c1",
            name: "korrelo-stg-run-1-app",
            state: "running",
            image: "img:1",
            labels: {
              "korrelo.projectId": "proj-1",
              "korrelo.stagingRunId": "run-1",
              "korrelo.ephemeral": "true",
              "com.docker.compose.project": "korrelo-stg-run-1",
            },
            publishedPorts: [19000],
            composeProject: "korrelo-stg-run-1",
          },
        ],
        publishedPorts: [19000],
        volumes: [{ name: "anon", labels: {} }],
      }),
    );

    const result = await service.recover({ now: NOW });

    expect(result.ok).toBe(true);
    expect(result.conflicts).toEqual(["run-1"]);
    expect(runs.recoveries[0].outcome).toBe("conflict");
  });

  it("inventário incompleto continua fail-closed (nada é alterado)", async () => {
    const runs = runRepository([run()]);
    const service = new StagingRunRecoveryService(
      runs.repository,
      leaseRepository(lease()),
      inventory({ complete: false, error: "docker volume inspect indisponível" }),
    );

    const result = await service.recover({ now: NOW });

    expect(result.ok).toBe(false);
    expect(result.expired).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(runs.recoveries).toHaveLength(0);
    expect(result.issues[0].code).toBe("STAGING_RECOVERY_INVENTORY_INCOMPLETE");
  });
});
