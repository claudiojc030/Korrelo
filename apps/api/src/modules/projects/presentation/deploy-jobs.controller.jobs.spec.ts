import { DeployJobsController } from "./deploy-jobs.controller";

/**
 * `GET /deploy-jobs` precisa entregar o estado operacional (espera, pausa,
 * tentativas) para o painel; `POST /deploy-jobs/:id/cancel` só cancela fila.
 */
describe("DeployJobsController — fila e cancelamento", () => {
  const baseJob = {
    id: "job-1",
    projectId: "proj-1",
    status: "queued",
    trigger: "manual",
    stage: "waiting-resources",
    attempt: 2,
    errorMessage: "Recursos insuficientes",
    commitSha: null,
    createdAt: new Date(),
  };

  function build(overrides: Partial<{ jobs: any[]; cancel: any }> = {}) {
    const jobs = overrides.jobs ?? [baseJob, { ...baseJob, id: "job-2", projectId: "proj-2" }];
    const queue = {
      findRecent: async () => jobs,
      describeJob: (job: any) => ({
        paused: false,
        waitingForResources: job.stage === "waiting-resources",
        nextAttemptAt: "2026-11-24T12:00:00.000Z",
        maxResourceAttempts: 5,
      }),
      cancel: overrides.cancel ?? (async () => ({ ok: true, job: { ...baseJob, status: "canceled" } })),
    };
    const controller = new DeployJobsController(
      queue as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { controller, queue };
  }

  it("devolve runtime por job e filtra por projeto", async () => {
    const { controller } = build();
    const result = await controller.recent("20", "proj-1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("job-1");
    expect(result[0].runtime).toMatchObject({
      waitingForResources: true,
      maxResourceAttempts: 5,
      nextAttemptAt: "2026-11-24T12:00:00.000Z",
    });
  });

  it("cancelar job na fila devolve 200", async () => {
    const { controller } = build();
    const result = await controller.cancel("job-1");
    expect(result).toEqual({ ok: true, jobId: "job-1", status: "canceled" });
  });

  it("cancelar job inexistente devolve 404", async () => {
    const { controller } = build({
      cancel: async () => ({ ok: false, reason: "not_found", job: null }),
    });
    const error = await controller.cancel("job-x").catch((caught: any) => caught);
    expect(error.getStatus()).toBe(404);
  });

  it("cancelar job em execução devolve 409 (não cancela build)", async () => {
    const { controller } = build({
      cancel: async () => ({ ok: false, reason: "not_queued", job: { ...baseJob, status: "running" } }),
    });
    const error = await controller.cancel("job-1").catch((caught: any) => caught);
    expect(error.getStatus()).toBe(409);
  });
});
