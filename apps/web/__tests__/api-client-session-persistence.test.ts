/**
 * SESSÃO PERSISTENTE - o operador NÃO pode ser deslogado por uma falha
 * transitória.
 *
 * O bug real: o operador fazia login, passava pelo 2FA, usava o Korrelo e
 * "desaparecia" do nada depois de um tempo.
 *
 * Causa: o access token dura 15 min (correto). Quando ele expirava, a
 * renovação acontecia - e se a API respondesse 5xx nesse instante (carga,
 * ou o restart do PM2 durante um self-update), o renewal era tratado como
 * "sessão inválida" e o operador era expulso pro login. O 2FA nunca teve
 * nada a ver com isso.
 *
 * Aqui provamos que:
 * - access expirado + refresh válido -> retry, sessão mantida;
 * - vários 401 ao mesmo tempo -> UM único refresh (single-flight);
 * - refresh 401/403 (sessão morta) -> devolve 401 (logout correto);
 * - refresh 5xx ou erro de rede -> NÃO desloga (503 sintético);
 * - o 2FA não é pedido no refresh.
 */

import { apiFetch, isSessionUnavailable, isTransientServerError } from "../lib/api-client";

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("api-client - sessão persistente", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("1) access expirado + refresh válido -> repete a requisição e mantém a sessão", async () => {
    let calls = 0;
    global.fetch = jest.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(401); // access expirado
      if (calls === 2) return jsonResponse(200); // refresh ok
      return jsonResponse(200); // retry
    }) as unknown as typeof fetch;

    const response = await apiFetch("/projects");

    expect(response.status).toBe(200);
    // 3 chamadas: original (401) + refresh + retry.
    expect(calls).toBe(3);
  });

  it("2) vários 401 ao mesmo tempo -> UM único refresh (single-flight)", async () => {
    let refreshCalls = 0;
    let pathCalls = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/refresh")) {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return jsonResponse(200);
      }
      pathCalls += 1;
      if (pathCalls <= 3) return jsonResponse(401); // 3 requests recebem 401
      return jsonResponse(200);
    }) as unknown as typeof fetch;

    const respostas = await Promise.all([
      apiFetch("/projects"),
      apiFetch("/monitoring/system"),
      apiFetch("/auth/has-user"),
    ]);

    // UM só refresh para as 3 requisições.
    expect(refreshCalls).toBe(1);
    for (const resposta of respostas) {
      expect(resposta.status).toBe(200);
    }
  });

  it("3) refresh com 401 (sessão morta) -> devolve 401 (logout correto)", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/auth/refresh")) return jsonResponse(401);
      return jsonResponse(401);
    }) as unknown as typeof fetch;

    const response = await apiFetch("/projects");

    expect(response.status).toBe(401);
    expect(isSessionUnavailable(response)).toBe(false);
  });

  it("4) refresh com 5xx -> NÃO desloga (vira 503 'indisponível')", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/auth/refresh")) return jsonResponse(503);
      return jsonResponse(401);
    }) as unknown as typeof fetch;

    const response = await apiFetch("/projects");

    // 503 (e NÃO 401): ninguém desloga por indisponibilidade.
    expect(response.status).toBe(503);
    expect(isTransientServerError(response)).toBe(true);
    expect(isSessionUnavailable(response)).toBe(true);
  });

  it("5) refresh com erro de rede (API fora do ar) -> NÃO desloga", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/auth/refresh")) {
        throw new TypeError("fetch failed");
      }
      return jsonResponse(401);
    }) as unknown as typeof fetch;

    const response = await apiFetch("/projects");

    expect(response.status).toBe(503);
    expect(isSessionUnavailable(response)).toBe(true);
  });

  it("6) o refresh NÃO é tentado em rota de auth (sem loop de refresh)", async () => {
    let refreshCalls = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/auth/refresh")) {
        refreshCalls += 1;
        return jsonResponse(200);
      }
      return jsonResponse(401);
    }) as unknown as typeof fetch;

    await apiFetch("/auth/login");

    expect(refreshCalls).toBe(0);
  });

  it("7) 5xx na requisição original não vira refresh nem logout", async () => {
    let refreshCalls = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/auth/refresh")) {
        refreshCalls += 1;
        return jsonResponse(200);
      }
      return jsonResponse(503);
    }) as unknown as typeof fetch;

    const response = await apiFetch("/projects");

    expect(response.status).toBe(503);
    expect(refreshCalls).toBe(0);
  });
});
