import { NextRequest } from "next/server";
import { proxy } from "../proxy";

/**
 * Teste do proxy (o "middleware" do Next 16) na hora de renovar a sessão.
 *
 * Cenário do incidente de 19/10/2026: com a API lenta/travada, o refresh de
 * sessão ficava pendurado e a navegação inteira travava (504 do Nginx). O
 * proxy precisa:
 * - ter TEMPO LIMITE (não segurar a navegação indefinidamente);
 * - NÃO deslogar o usuário quando a API está só lenta (só quando ela
 *   responde que a sessão é inválida).
 */
jest.setTimeout(20_000);

function requestWithSession(): NextRequest {
  return new NextRequest(new URL("http://korrelo.local/dashboard"), {
    headers: {
      cookie: "korrelo_refresh_token=token-de-refresh",
    },
  });
}

describe("proxy - renovação de sessão", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("renova a sessão e repassa o cookie novo quando a API responde", async () => {
    global.fetch = jest.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "set-cookie": "korrelo_token=token-novo; Path=/; HttpOnly",
          },
        }),
    ) as unknown as typeof fetch;

    const response = await proxy(requestWithSession());

    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain("korrelo_token=token-novo");
  });

  it("redireciona pro login quando a API responde que a sessão é inválida", async () => {
    global.fetch = jest.fn(async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;

    const response = await proxy(requestWithSession());

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
  });

  it("NÃO desloga o usuário quando a API está lenta (timeout) e NUNCA fica pendurado", async () => {
    global.fetch = jest.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;

    const startedAt = Date.now();
    const response = await proxy(requestWithSession());
    const elapsed = Date.now() - startedAt;

    // Segue a navegação (sem redirect pro login): a sessão pode estar válida.
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    // E não segura a navegação indefinidamente.
    expect(elapsed).toBeLessThan(12_000);
  });

  it("não tenta renovar quando já existe access token", async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const request = new NextRequest(new URL("http://korrelo.local/dashboard"), {
      headers: {
        cookie: "korrelo_token=token-atual; korrelo_refresh_token=token-de-refresh",
      },
    });

    const response = await proxy(request);

    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
