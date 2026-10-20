import {
  apiFetch,
  backoffDelay,
  isAuthFailure,
  isNetworkError,
  isTransientServerError,
  RECONNECT_BACKOFF_MS,
} from "../lib/api-client";

/**
 * Wave 3: erro de REDE não é sessão inválida.
 *
 * Incidente real: durante o self-update a API reinicia; o polling do
 * navegador recebia "xhr poll error" e a UI mostrava "Não autenticado" -
 * expulsando o usuário de uma sessão perfeitamente válida.
 *
 * Regras:
 * - só uma resposta 401 REAL invalida a sessão (e dispara o refresh);
 * - 502/503/504 e erro de rede são TRANSITÓRIOS (a API está reiniciando);
 * - o backoff do polling é limitado: 1s, 2s, 3s, 5s, 5s...
 */

describe("api-client - rede x 401", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("10) erro de rede NÃO vira logout (a requisição lança, mas não há 401)", async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(apiFetch("/monitoring/self-update/current")).rejects.toThrow("fetch failed");
    // Nenhum refresh foi tentado (o erro de rede não é sessão inválida).
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("10b) o erro de rede é reconhecido como transitório", () => {
    expect(isNetworkError(new TypeError("fetch failed"))).toBe(true);
    expect(isNetworkError(new Error("xhr poll error"))).toBe(true);
    expect(isNetworkError(new Error("qualquer outra coisa"))).toBe(false);
  });

  it("11/12/13) 502, 503 e 504 NÃO viram logout (nem tentam refresh)", async () => {
    for (const status of [502, 503, 504]) {
      global.fetch = jest.fn(async () => new Response("{}", { status })) as unknown as typeof fetch;

      const response = await apiFetch("/monitoring/self-update/current");

      expect(response.status).toBe(status);
      expect(isTransientServerError(response)).toBe(true);
      expect(isAuthFailure(response)).toBe(false);
      // Só UMA chamada: não houve tentativa de refresh.
      expect(global.fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("14) um 401 real continua invalida a sessão (e tenta o refresh)", async () => {
    const calls: string[] = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/auth/refresh")) return new Response("{}", { status: 200 });
      return new Response("{}", { status: 401 });
    }) as unknown as typeof fetch;

    const response = await apiFetch("/monitoring/self-update/current");

    // O refresh foi tentado e a requisição refeita.
    expect(calls.some((url) => url.includes("/auth/refresh"))).toBe(true);
    expect(calls.filter((url) => url.includes("/self-update/current"))).toHaveLength(2);
    expect(response.status).toBe(401);
  });

  it("14b) 401 sem refresh válido devolve o 401 (a sessão realmente morreu)", async () => {
    global.fetch = jest.fn(async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;

    const response = await apiFetch("/monitoring/self-update/current");

    expect(response.status).toBe(401);
    expect(isAuthFailure(response)).toBe(true);
  });

  it("15) refresh válido preserva o login (a sessão continua)", async () => {
    let attempts = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/refresh")) {
        return new Response("{}", {
          status: 200,
          headers: { "set-cookie": "korrelo_token=novo; Path=/; HttpOnly" },
        });
      }
      attempts += 1;
      // A primeira tentativa cai (access token expirado); depois do refresh
      // a sessão é válida de novo.
      return new Response("{}", { status: attempts === 1 ? 401 : 200 });
    }) as unknown as typeof fetch;

    const response = await apiFetch("/monitoring/self-update/current");

    // A requisição original foi refeita com sucesso.
    expect(response.status).toBe(200);
  });

  it("16) refresh inválido pede login (401 devolvido)", async () => {
    global.fetch = jest.fn(async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;

    const response = await apiFetch("/monitoring/self-update/current");

    expect(response.status).toBe(401);
  });

  it("25) o backoff do polling é limitado (1s, 2s, 3s, 5s, 5s...)", () => {
    expect(RECONNECT_BACKOFF_MS).toEqual([1000, 2000, 3000, 5000, 5000]);
    expect(backoffDelay(0)).toBe(1000);
    expect(backoffDelay(1)).toBe(2000);
    expect(backoffDelay(2)).toBe(3000);
    expect(backoffDelay(3)).toBe(5000);
    expect(backoffDelay(99)).toBe(5000);
  });
});
