import { DeployJobsController } from "./deploy-jobs.controller";

/**
 * Auditoria administrativa: somente leitura, sem deploy, recusada com fila
 * ocupada e sem qualquer operação destrutiva.
 */
describe("DeployJobsController.imageGcAuditRun", () => {
  function build(running: unknown[] = [], queued: unknown[] = []) {
    const auditCalls: number[] = [];
    const plan = {
      mode: "dry-run",
      decisions: [
        { reference: "korrelo-mesatta-8452004c:commit-b162880a5c14", id: "sha256:a", decision: "KEEP", reasons: ["protegida"] },
      ],
      summary: { keep: 1, candidate: 0, unknown: 0, skipped: false },
      notes: [],
    };
    const controller = new DeployJobsController(
      {} as any,
      {} as any,
      {} as any,
      { audit: async () => { auditCalls.push(1); return plan; } } as any,
      {
        findAllByStatus: async (status: string) => (status === "running" ? running : queued),
      } as any,
    );
    return { controller, auditCalls };
  }

  it("executa a auditoria sem disparar deploy e devolve timestamp", async () => {
    const { controller, auditCalls } = build();

    const result = await controller.imageGcAuditRun();

    expect(auditCalls).toHaveLength(1);
    expect(result.mode).toBe("dry-run");
    expect(result.summary.keep).toBe(1);
    expect(typeof result.auditedAt).toBe("string");
    // Nada além da auditoria foi chamado (os serviços são stubs vazios).
  });

  it("recusa (409) quando há job rodando", async () => {
    const { controller, auditCalls } = build([{ id: "job-1" }]);

    const error = await controller.imageGcAuditRun().catch((caught: any) => caught);
    expect(error.getStatus()).toBe(409);
    expect(auditCalls).toHaveLength(0);
  });

  it("recusa quando há job na fila", async () => {
    const { controller, auditCalls } = build([], [{ id: "job-2" }]);

    const error = await controller.imageGcAuditRun().catch((caught: any) => caught);
    expect(error.getStatus()).toBe(409);
    expect(auditCalls).toHaveLength(0);
  });
});
