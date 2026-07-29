import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { JwtAuthGuard } from "./jwt-auth.guard";
import type { TokenService } from "../domain/token-service";

function buildContext(headers: Record<string, string>): ExecutionContext {
  const request: { headers: Record<string, string>; user?: unknown } = { headers };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
  } as unknown as ExecutionContext;
}

describe("JwtAuthGuard", () => {
  it("libera acesso direto quando a rota é marcada @Public()", () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(true) } as unknown as Reflector;
    const tokenService: TokenService = { sign: jest.fn(), verify: jest.fn() };
    const guard = new JwtAuthGuard(reflector, tokenService);

    const result = guard.canActivate(buildContext({}));

    expect(result).toBe(true);
    expect(tokenService.verify).not.toHaveBeenCalled();
  });

  it("rejeita quando não há header Authorization", () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector;
    const tokenService: TokenService = { sign: jest.fn(), verify: jest.fn() };
    const guard = new JwtAuthGuard(reflector, tokenService);

    expect(() => guard.canActivate(buildContext({}))).toThrow(UnauthorizedException);
  });

  it("rejeita quando o token é inválido ou expirado", () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector;
    const tokenService: TokenService = { sign: jest.fn(), verify: jest.fn().mockReturnValue(null) };
    const guard = new JwtAuthGuard(reflector, tokenService);

    expect(() =>
      guard.canActivate(buildContext({ authorization: "Bearer token-invalido" })),
    ).toThrow(UnauthorizedException);
  });

  it("libera acesso e anexa o usuário na request quando o token é válido", () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector;
    const payload = { sub: "user-1", email: "admin@korrelo.local" };
    const tokenService: TokenService = { sign: jest.fn(), verify: jest.fn().mockReturnValue(payload) };
    const guard = new JwtAuthGuard(reflector, tokenService);

    const context = buildContext({ authorization: "Bearer token-valido" });
    const result = guard.canActivate(context);

    expect(result).toBe(true);
    expect(context.switchToHttp().getRequest().user).toEqual(payload);
  });
});
