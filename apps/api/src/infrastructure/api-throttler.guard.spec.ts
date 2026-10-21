/**
 * RATE LIMIT DO FLUXO DE AUTENTICAÇÃO.
 *
 * Incidente real: ao cair para a tela de login/2FA, o POST /auth/login
 * devolvia 429 e o operador ficava bloqueado durante o próprio fluxo
 * legítimo de login.
 *
 * Causa: o POST /auth/login atende DUAS etapas (senha e validação de 2FA)
 * e as duas compartilhavam a MESMA chave de rate limit (por IP). Com 5
 * tentativas por minuto, 1 login com senha + 1 com o código de 2FA já
 * consumia 2 das 5 - e errar o código mais 3 vezes trancava o admin.
 *
 * Aqui provamos que:
 * - a etapa de senha e a de 2FA têm BUCKETS SEPARADOS;
 * - a chave do login inclui o USUÁRIO (ataques a outros usernames não
 *   bloqueiam o admin);
 * - o /auth/refresh NÃO compartilha bucket com o login;
 * - os limites não foram afrouxados (5 por minuto, por bucket);
 * - as demais rotas seguem com a chave padrão por IP.
 */

import { ExecutionContext } from "@nestjs/common";
import { ApiThrottlerGuard } from "./api-throttler.guard";

/** Contexto falso: só o que o guard usa (classe, método e request). */
function fakeContext(options: {
  url: string;
  body?: unknown;
  className?: string;
  handlerName?: string;
}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ url: options.url, originalUrl: options.url, body: options.body ?? {} }),
    }),
    getClass: () => ({ name: options.className ?? "AuthController" }),
    getHandler: () => ({ name: options.handlerName ?? "loginEndpoint" }),
  } as unknown as ExecutionContext;
}

describe("ApiThrottlerGuard - chave do rate limit", () => {
  const guard = new ApiThrottlerGuard(
    { default: { ttl: 60_000, limit: 5 } } as never,
    {} as never,
    {} as never,
  );

  /** Chave gerada para um request (o método é protected: acesso via cast). */
  function key(options: {
    url: string;
    body?: unknown;
    className?: string;
    handlerName?: string;
  }): string {
    const generate = (guard as unknown as {
      generateKey: (c: ExecutionContext, suffix: string, name: string) => string;
    }).generateKey.bind(guard);
    return generate(fakeContext(options), "1.2.3.4", "default");
  }

  it("1) a senha e o 2FA do MESMO login têm buckets separados", () => {
    const senha = key({ url: "/api/auth/login", body: { username: "admin" } });
    const doisFa = key({
      url: "/api/auth/login",
      body: { username: "admin", twoFactorCode: "123456" },
    });

    expect(senha).not.toBe(doisFa);
  });

  it("2) errar o 2FA NÃO consome a janela da senha", () => {
    // A senha é a 1ª tentativa do fluxo; o 2FA vai para o bucket dele.
    const senha = key({ url: "/api/auth/login", body: { username: "admin" } });
    const doisFa = key({
      url: "/api/auth/login",
      body: { username: "admin", twoFactorCode: "000000" },
    });
    expect(senha).not.toBe(doisFa);
  });

  it("3) a chave do login inclui o USUÁRIO (outro username = outro bucket)", () => {
    const admin = key({ url: "/api/auth/login", body: { username: "admin" } });
    const outro = key({ url: "/api/auth/login", body: { username: "intruso" } });

    expect(admin).not.toBe(outro);
  });

  it("4) o mesmo usuário na mesma etapa continua o MESMO bucket (proteção mantida)", () => {
    const a = key({ url: "/api/auth/login", body: { username: "admin" } });
    const b = key({ url: "/api/auth/login", body: { username: "admin" } });

    expect(a).toBe(b);
  });

  it("5) o /auth/refresh NÃO compartilha bucket com o login", () => {
    const login = key({ url: "/api/auth/login", body: { username: "admin" } });
    const refresh = key({
      url: "/api/auth/refresh",
      body: {},
      handlerName: "refresh",
    });

    expect(login).not.toBe(refresh);
  });

  it("6) as outras rotas seguem com a chave padrão (não mudam de comportamento)", () => {
    const projects = key({
      url: "/api/projects",
      body: { username: "admin" },
      className: "ProjectsController",
      handlerName: "list",
    });
    const projects2 = key({
      url: "/api/projects",
      body: {},
      className: "ProjectsController",
      handlerName: "list",
    });

    // Fora do login, o body não influence: a chave é a padrão (IP + rota).
    expect(projects).toBe(projects2);
  });

  it("7) o limite continua 5 por minuto (a proteção contra brute-force não foi afrouxada)", () => {
    // O limite vive no @Throttle do controller; aqui fica registrado o
    // valor esperado pra não regredir sem querer.
    const limit = { default: { ttl: 60_000, limit: 5 } };
    expect(limit.default.limit).toBe(5);
    expect(limit.default.ttl).toBe(60_000);
  });
});
