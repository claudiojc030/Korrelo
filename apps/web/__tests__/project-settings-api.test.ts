import { patchProjectSettings } from "../lib/project-settings-api";

describe("patchProjectSettings", () => {
  it("envia PATCH e retorna sucesso", async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    const fetcher = async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return new Response(null, { status: 200 });
    };

    const result = await patchProjectSettings(fetcher, "p1", {
      healthcheck: { deployPath: "/health/ready", deployTimeoutSeconds: 120 },
    });

    expect(result).toEqual({ ok: true });
    expect(calls[0].path).toBe("/projects/p1/settings");
    expect(calls[0].init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      healthcheck: { deployPath: "/health/ready", deployTimeoutSeconds: 120 },
    });
  });

  it("falha de API devolve mensagem real para a UI", async () => {
    const fetcher = async () =>
      new Response(JSON.stringify({ code: "INVALID", message: "valor inválido" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });

    const result = await patchProjectSettings(fetcher, "p1", { skipStagingTest: true });

    expect(result).toEqual({ ok: false, status: 400, message: "valor inválido" });
  });

  it("erro sem JSON não lança", async () => {
    const fetcher = async () => new Response("erro", { status: 500 });
    const result = await patchProjectSettings(fetcher, "p1", {});
    expect(result).toEqual({ ok: false, status: 500, message: null });
  });
});
