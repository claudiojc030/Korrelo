import { StagingRunRecoveryScheduler } from "./staging-run-recovery.scheduler";
import type { StagingRunRecoveryService } from "../application/staging-run-recovery.service";

function recovery(result: Awaited<ReturnType<StagingRunRecoveryService["recover"]>>) {
  const calls: Array<{ now?: Date }> = [];
  const service = {
    recover: async (options?: { now?: Date }) => {
      calls.push(options ?? {});
      return result;
    },
  } as unknown as StagingRunRecoveryService;
  return { service, calls };
}

describe("StagingRunRecoveryScheduler", () => {
  const previous = process.env.KORRELO_STAGING_ISOLATED_EXECUTION;
  beforeEach(() => {
    process.env.KORRELO_STAGING_ISOLATED_EXECUTION = "true";
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.KORRELO_STAGING_ISOLATED_EXECUTION;
    else process.env.KORRELO_STAGING_ISOLATED_EXECUTION = previous;
  });

  it("não executa com a flag desligada", async () => {
    process.env.KORRELO_STAGING_ISOLATED_EXECUTION = "false";
    const fake = recovery({ ok: true, inspected: 0, expired: [], conflicts: [], orphans: [], issues: [] });
    const scheduler = new StagingRunRecoveryScheduler(fake.service);
    await scheduler.onModuleInit();
    await scheduler.handleInterval();
    expect(fake.calls).toHaveLength(0);
  });

  it("executa no boot e aplica o resultado conservador", async () => {
    const fake = recovery({
      ok: true,
      inspected: 1,
      expired: ["run-1"],
      conflicts: [],
      orphans: [],
      issues: [],
    });
    const scheduler = new StagingRunRecoveryScheduler(fake.service);

    await scheduler.onModuleInit();

    expect(fake.calls).toHaveLength(1);
  });

  it("não propaga falha da recuperação", async () => {
    const service = {
      recover: async () => {
        throw new Error("docker offline");
      },
    } as unknown as StagingRunRecoveryService;
    const scheduler = new StagingRunRecoveryScheduler(service);

    await expect(scheduler.onModuleInit()).resolves.toBeUndefined();
  });

  it("não roda duas recuperações concorrentes", async () => {
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let calls = 0;
    const service = {
      recover: async () => {
        calls += 1;
        await gate;
        return { ok: true, inspected: 0, expired: [], conflicts: [], orphans: [], issues: [] };
      },
    } as unknown as StagingRunRecoveryService;
    const scheduler = new StagingRunRecoveryScheduler(service);

    const first = scheduler.onModuleInit();
    await Promise.resolve();
    await scheduler.handleInterval();
    releaseGate();
    await first;

    expect(calls).toBe(1);
  });
});
