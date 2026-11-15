import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import type { StagingPortLease } from "../../src/modules/projects/domain/staging-lease";
import type {
  RecoverStagingRunInput,
  RecoverStagingRunResult,
  ReserveStagingRunInput,
  ReserveStagingRunResult,
  StagingRun,
  StagingRunRepository,
} from "../../src/modules/projects/domain/staging-run";

interface LabState {
  runs: Array<StagingRun & { serializedDates: true }>;
  leases: Array<StagingPortLease & { serializedDates: true }>;
}

/**
 * Adaptador de repositório EXCLUSIVO do laboratório.
 *
 * O repositório real é Prisma/SQLite (P1B3). Aqui a persistência é um JSON
 * local para permitir o teste de recuperação entre processos no runner. A
 * lógica de reserva atômica do Prisma não é exercitada por este adaptador.
 */
export class LabRunRepository implements StagingRunRepository {
  constructor(private readonly stateFile: string) {}

  async reserve(input: ReserveStagingRunInput): Promise<ReserveStagingRunResult> {
    const state = this.load();
    if (process.env.LAB_FORCE_CAPACITY === "fail") {
      return {
        ok: false,
        run: null,
        lease: null,
        issues: [
          {
            code: "STAGING_CAPACITY_MEMORY",
            field: "memoryMb",
            message: "Memória insuficiente (falha forçada do laboratório).",
          },
        ],
        capacity: null,
      };
    }
    const active = state.leases.filter((lease) => lease.status === "active");
    if (active.length + 1 > input.policy.maxConcurrentEnvironments) {
      return {
        ok: false,
        run: null,
        lease: null,
        issues: [
          {
            code: "STAGING_CAPACITY_CONCURRENCY",
            field: "activeEnvironments",
            message: `Limite de ambientes atingido (${active.length}/${input.policy.maxConcurrentEnvironments}).`,
          },
        ],
        capacity: null,
      };
    }
    const forced = Number(process.env.LAB_FORCE_PORT ?? "");
    let hostPort: number | null = null;
    if (Number.isInteger(forced) && forced > 0) {
      hostPort = forced;
    } else {
      for (const candidate of input.portCandidates) {
        if (await isPortFree(candidate)) {
          hostPort = candidate;
          break;
        }
      }
    }
    if (hostPort === null) {
      return {
        ok: false,
        run: null,
        lease: null,
        issues: [{ code: "STAGING_CAPACITY_PORT", field: "port", message: "Nenhuma porta candidata disponível." }],
        capacity: null,
      };
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.ttlMinutes * 60_000);
    const lease: StagingPortLease = {
      id: `lease-${input.runId}`,
      projectId: input.projectId,
      runId: input.runId,
      hostPort,
      status: "active",
      expiresAt,
      memoryMb: input.app.memoryMb + input.dependencies.reduce((sum, item) => sum + item.memoryMb, 0),
      cpu: input.app.cpu + input.dependencies.reduce((sum, item) => sum + item.cpu, 0),
      diskMb: input.app.diskMb + input.dependencies.reduce((sum, item) => sum + item.diskMb, 0),
      ownerId: input.ownerId ?? null,
      createdAt: now,
      updatedAt: now,
      releasedAt: null,
    };
    const run: StagingRun = {
      id: `run-${input.runId}`,
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
      memoryMb: lease.memoryMb,
      cpu: lease.cpu,
      diskMb: lease.diskMb,
      leaseId: lease.id,
      networkName: input.networkName ?? null,
      volumePrefix: input.volumePrefix ?? null,
      ownerId: input.ownerId ?? null,
      cleanupState: "none",
      createdAt: now,
      updatedAt: now,
      expiresAt,
    };
    state.runs.push(run as StagingRun & { serializedDates: true });
    state.leases.push(lease as StagingPortLease & { serializedDates: true });
    this.save(state);
    return { ok: true, run, lease, issues: [], capacity: null };
  }

  async findByProjectAndRun(projectId: string, runId: string): Promise<StagingRun | null> {
    const state = this.load();
    const row = state.runs.find((run) => run.projectId === projectId && run.runId === runId);
    return row ? hydrateRun(row) : null;
  }

  async findExpired(now: Date): Promise<StagingRun[]> {
    const state = this.load();
    return state.runs.filter((run) => run.status !== "destroyed" && run.status !== "expired" && new Date(run.expiresAt) < now).map(hydrateRun);
  }

  async recoverRun(input: RecoverStagingRunInput): Promise<RecoverStagingRunResult> {
    const run = await this.findByProjectAndRun(input.projectId, input.runId);
    if (!run) return { ok: false, run: null, lease: null, reason: "not_found" };
    return { ok: false, run, lease: null, reason: "renewed" };
  }

  private load(): LabState {
    if (!existsSync(this.stateFile)) return { runs: [], leases: [] };
    try {
      return JSON.parse(readFileSync(this.stateFile, "utf8")) as LabState;
    } catch {
      return { runs: [], leases: [] };
    }
  }

  private save(state: LabState): void {
    writeFileSync(this.stateFile, JSON.stringify(state, null, 2), "utf8");
  }
}

function hydrateRun(row: StagingRun & { serializedDates: true }): StagingRun {
  return {
    ...row,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    expiresAt: new Date(row.expiresAt),
  };
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}
