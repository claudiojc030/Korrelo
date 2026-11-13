import { reconcileProjectState } from "../lib/project-reconcile";

/**
 * RECONCILIAÇÃO (frontend): só pode chamar POST /projects/:id/reconcile.
 * Nada de deploy, rollback ou restart.
 */
describe("reconcileProjectState", () => {
  const project = { id: "p1", name: "Mesatta", lastDeployStatus: "indeterminate" };

  it("sucesso retorna o projeto reconciliado", async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    const fetcher = async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return new Response(JSON.stringify(project), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await reconcileProjectState(fetcher, "p1");

    expect(result).toEqual({ ok: true, project });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/projects/p1/reconcile");
    expect(calls[0].init?.method).toBe("POST");
    // Nenhuma chamada a /deploy ou /rollback.
    expect(calls.some((call) => /deploy|rollback|restart/.test(call.path))).toBe(false);
  });

  it("HTTP 409 mantém o bloqueio e devolve a mensagem da API", async () => {
    const fetcher = async () =>
      new Response(
        JSON.stringify({ code: "PROJECT_RECONCILE_UNHEALTHY", message: "readiness não respondeu" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );

    const result = await reconcileProjectState(fetcher, "p1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.message).toContain("readiness");
    }
  });

  it("erro de API sem corpo JSON não lança", async () => {
    const fetcher = async () => new Response("erro interno", { status: 500 });
    const result = await reconcileProjectState(fetcher, "p1");
    expect(result).toEqual({ ok: false, status: 500, message: null });
  });
});
