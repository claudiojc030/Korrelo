import {
  describeDeployJob,
  formatDeployDateTime,
  formatDeployTime,
  type DeployJobView,
} from "../app/(app)/projects/[projectId]/deploy-job-status";

function job(overrides: Partial<DeployJobView> = {}): DeployJobView {
  return {
    id: "job-1",
    projectId: "proj-1",
    status: "queued",
    trigger: "manual",
    stage: "queued",
    attempt: 0,
    errorMessage: null,
    commitSha: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    runtime: {
      paused: false,
      waitingForResources: false,
      nextAttemptAt: null,
      maxResourceAttempts: 5,
    },
    ...overrides,
  };
}

describe("describeDeployJob", () => {
  it("fila recém-criada é 'solicitação recebida', não 'build iniciado'", () => {
    const result = describeDeployJob(job());
    expect(result.phase).toBe("received");
    expect(result.active).toBe(true);
    expect(result.terminal).toBe(false);
    expect(result.canCancel).toBe(true);
  });

  it("waiting-resources mostra espera e permite cancelar", () => {
    const result = describeDeployJob(
      job({
        stage: "waiting-resources",
        attempt: 2,
        runtime: {
          paused: false,
          waitingForResources: true,
          nextAttemptAt: new Date().toISOString(),
          maxResourceAttempts: 5,
        },
      }),
    );
    expect(result.phase).toBe("waiting-resources");
    expect(result.canCancel).toBe(true);
    expect(result.canResume).toBe(false);
    expect(result.maxAttempts).toBe(5);
  });

  it("job pausado no startup pede resume e não roda sozinho", () => {
    const result = describeDeployJob(
      job({
        runtime: {
          paused: true,
          waitingForResources: false,
          nextAttemptAt: null,
          maxResourceAttempts: 5,
        },
      }),
    );
    expect(result.phase).toBe("paused");
    expect(result.active).toBe(false);
    expect(result.canResume).toBe(true);
    expect(result.canCancel).toBe(true);
  });

  it("running nunca é cancelável e distingue build de promoção", () => {
    expect(describeDeployJob(job({ status: "running", stage: "building" })).phase).toBe("building");
    expect(describeDeployJob(job({ status: "running", stage: "promote" })).phase).toBe("promoting");
    const running = describeDeployJob(job({ status: "running", stage: "staging-health" }));
    expect(running.phase).toBe("staging");
    expect(running.canCancel).toBe(false);
    expect(running.active).toBe(true);
  });

  it("concluído, falho, cancelado e interrompido são terminais", () => {
    for (const status of ["succeeded", "failed", "canceled", "interrupted"] as const) {
      const result = describeDeployJob(job({ status, stage: null }));
      expect(result.phase).toBe(status === "succeeded" ? "succeeded" : status);
      expect(result.terminal).toBe(true);
      expect(result.active).toBe(false);
      expect(result.canCancel).toBe(false);
    }
  });

  it("datas são determinísticas no fuso de São Paulo (sem mismatch SSR/cliente)", () => {
    // 2026-11-24T15:00:00Z = 12:00 em America/Sao_Paulo (UTC-3).
    expect(formatDeployDateTime("2026-11-24T15:00:00.000Z")).toBe("24/11/2026 12:00:00");
    expect(formatDeployTime("2026-11-24T15:00:00.000Z")).toBe("12:00");
    expect(formatDeployDateTime("nao-e-data")).toBe("nao-e-data");
    expect(formatDeployTime("nao-e-data")).toBe("—");
  });
});
