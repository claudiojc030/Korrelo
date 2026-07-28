import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { TOKEN_SERVICE, type TokenService } from "../domain/token-service";
import { IS_PUBLIC_KEY } from "./public.decorator";
import { TOKEN_COOKIE } from "./token-cookie";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_SERVICE) private readonly tokenService: TokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers.authorization;
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
    // Chamadas do próprio navegador (fetch com credentials: "include") não mandam
    // Authorization — o token vai só no cookie httpOnly, inacessível a JS.
    const token = bearerToken ?? request.cookies?.[TOKEN_COOKIE] ?? null;

    if (!token) {
      throw new UnauthorizedException("Token de acesso ausente.");
    }

    const payload = this.tokenService.verify(token);
    if (!payload) {
      throw new UnauthorizedException("Token de acesso inválido ou expirado.");
    }

    request.user = payload;
    return true;
  }
}
