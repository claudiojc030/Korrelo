import { fetchApiServer } from "../lib/api-server-fetch";

/**
 * Teste do helper de fetch usado pelos Server Components do painel.
 *
 * Cenário: no incidente de 19/10/2026 um fetch sem timeout ficava pendurado
 * e a página inteira travava até o Nginx desistir (504).
 */
describe("fetchApiServer (uso nos Server Components)", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("devolve os dados quando a API responde", async () => {
    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const result = await fetchApiServer<{ ok: boolean }>("/projects");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.ok).toBe(true);
    }
  });

  it("reporta falha HTTP sem throwing", async () => {
    global.fetch = jest.fn(async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;

    const result = await fetchApiServer("/projects");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("http");
      expect(result.status).toBe(500);
    }
  });

  it("reporta erro de rede sem throwing", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await fetchApiServer("/projects");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("network");
    }
  });

  it("corta a espera quando a API não responde (timeout) e NÃO fica pendurado", async () => {
    global.fetch = jest.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;

    const startedAt = Date.now();
    const result = await fetchApiServer("/projects", { timeoutMs: 150 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("timeout");
    }
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });
});
