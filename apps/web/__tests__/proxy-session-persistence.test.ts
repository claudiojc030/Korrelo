/**
 * PROXY (SSR) - a navegação de página não pode deslogar por falha
 * transitória da API.
 *
 * O proxy renova a sessão quando o access token (15 min) expirou. Se a
 * API respondesse 5xx nesse instante (carga, ou o restart do PM2 durante
 * um self-update), a renovação era tratada como "sessão inválida" e o
 * operador era expulso pro login.
 *
 * Aqui provamos que:
 * - 401/403 no refresh -> redireciona pro login (sessão morta de verdade);
 * - 5xx no refresh -> segue a navegação (sessão mantida);
 * - erro de rede/timeout -> segue a navegação;
 * - sem cookie nenhum -> redireciona pro login.
 */

import { NextRequest } from "next/server";

const REFRESH_COOKIE = "korrelo_refresh_token";
const TOKEN_COOKIE = "korrelo_token";

function makeRequest(pathname = "/dashboard"): NextRequest {
  const url = `https://korrelo.exemplo${pathname}`;
  const request = new NextRequest(url);
  request.cookies.set(REFRESH_COOKIE, "refresh-abc");
  return request;
}

describe("proxy - sessão persistente (SSR)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function runProxy(request: NextRequest) {
    const { proxy } = await import("../proxy");
    return proxy(request);
  }

  it("1) refresh com 401 -> redireciona pro login (sessão morta)", async () => {
    global.fetch = jest.fn(async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;

    const response = await runProxy(makeRequest());

    expect(response.headers.get("location")).toContain("/login");
  });

  it("2) refresh com 403 -> redireciona pro login", async () => {
    global.fetch = jest.fn(async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;

    const response = await runProxy(makeRequest());

    expect(response.headers.get("location")).toContain("/login");
  });

  it("3) refresh com 503 -> SEGUE a navegação (a sessão foi mantida)", async () => {
    global.fetch = jest.fn(async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;

    const response = await runProxy(makeRequest());

    // Sem redirect: o operador continua logado.
    expect(response.headers.get("location")).toBeNull();
  });

  it("4) refresh com 502/504 -> também segue a navegação", async () => {
    for (const status of [502, 504]) {
      global.fetch = jest.fn(async () => new Response("{}", { status })) as unknown as typeof fetch;
      const response = await runProxy(makeRequest());
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it("5) erro de rede (API fora do ar) -> segue a navegação", async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const response = await runProxy(makeRequest());

    expect(response.headers.get("location")).toBeNull();
  });

  it("6) refresh válido -> segue a navegação e renova o cookie de access", async () => {
    global.fetch = jest.fn(async () => {
      const headers = new Headers();
      headers.append("set-cookie", `${TOKEN_COOKIE}=novo-access; Path=/; HttpOnly`);
      return new Response("{}", { status: 200, headers });
    }) as unknown as typeof fetch;

    const response = await runProxy(makeRequest());

    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toContain(TOKEN_COOKIE);
  });

  it("7) sem cookie de sessão -> redireciona pro login", async () => {
    const request = new NextRequest("https://korrelo.exemplo/dashboard");

    const response = await runProxy(request);

    expect(response.headers.get("location")).toContain("/login");
  });
});
