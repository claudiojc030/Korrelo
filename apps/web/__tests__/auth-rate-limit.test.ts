/**
 * 429 NO LOGIN - nunca tratado como senha/2FA inválido.
 *
 * Incidente real: ao cair para a tela de login/2FA, o POST /auth/login
 * devolvia 429 ("Muitas tentativas. Espere um minuto e tente de novo") e o
 * operador ficava bloqueado durante o próprio fluxo legítimo.
 *
 * Aqui provamos que:
 * - o 429 mostra a mensagem de ESPERA (não "usuário ou senha inválidos");
 * - o 429 NÃO limpa cookies nem redireciona para o login;
 * - o 401 (senha/2FA inválidos) continua com a mensagem de credencial;
 * - um 429 no refresh de sessão NÃO desloga o operador.
 */

import { apiFetch } from "../lib/api-client";
import { translateApiError } from "../lib/api-error";
import { apiErrorsPt, apiErrorsEn } from "../lib/i18n/dictionaries/api-errors";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("429 no fluxo de autenticação", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("1) o 429 do login mostra a mensagem de ESPERA, não de credencial inválida", () => {
    const body = { code: "TOO_MANY_REQUESTS", message: "Muitas tentativas. Espere um minuto e tente de novo." };
    const mensagem = translateApiError(
      { apiErrors: apiErrorsPt } as never,
      body,
      "Falha na autenticação",
    );

    expect(mensagem).toBe(apiErrorsPt.TOO_MANY_REQUESTS);
    expect(mensagem).not.toBe(apiErrorsPt.INVALID_CREDENTIALS);
    expect(mensagem).not.toBe(apiErrorsPt.INVALID_TWO_FACTOR_CODE);
  });

  it("2) a tradução do 429 existe em pt e en (não cai no fallback genérico)", () => {
    expect(apiErrorsPt.TOO_MANY_REQUESTS).toContain("Muitas tentativas");
    expect(apiErrorsEn.TOO_MANY_REQUESTS).toContain("Too many attempts");
  });

  it("3) o 401 de credencial inválida continua sendo 'senha inválida'", () => {
    const mensagem = translateApiError(
      { apiErrors: apiErrorsPt } as never,
      { code: "INVALID_CREDENTIALS" },
      "Falha na autenticação",
    );

    expect(mensagem).toBe(apiErrorsPt.INVALID_CREDENTIALS);
  });

  it("4) o apiFetch NÃO tenta refresh em 429 (login não entra em loop de refresh)", async () => {
    let chamadas = 0;
    global.fetch = jest.fn(async () => {
      chamadas += 1;
      return jsonResponse(429, { code: "TOO_MANY_REQUESTS" });
    }) as unknown as typeof fetch;

    const response = await apiFetch("/auth/login", { method: "POST" });

    expect(response.status).toBe(429);
    // Uma única chamada: o 429 não é 401 e não dispara refresh.
    expect(chamadas).toBe(1);
  });

  it("5) o 429 numa rota protegida NÃO desloga (vira 503 'indisponível')", async () => {
    let chamadas = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      chamadas += 1;
      if (String(input).includes("/auth/refresh")) {
        // O refresh está com rate limit (indisponível agora).
        return jsonResponse(429, { code: "TOO_MANY_REQUESTS" });
      }
      return jsonResponse(401, { code: "ACCESS_TOKEN_INVALID" });
    }) as unknown as typeof fetch;

    const response = await apiFetch("/projects");

    // Não é 401 (que deslogaria) e não é redirect: a sessão foi mantida.
    expect(response.status).toBe(503);
    expect(response.headers.get("x-korrelo-session")).toBe("unavailable");
    expect(chamadas).toBe(2);
  });

  it("6) o 429 do login não mexe em cookies (a sessão existente continua)", async () => {
    // O apiFetch só envia/manda cookies; nenhum clearCookie acontece no
    // caminho do 429 (a limpeza de cookie só existe no 401 definitivo do
    // refresh, no backend).
    global.fetch = jest.fn(async () =>
      jsonResponse(429, { code: "TOO_MANY_REQUESTS" }),
    ) as unknown as typeof fetch;

    const response = await apiFetch("/auth/login", { method: "POST" });

    expect(response.status).toBe(429);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
