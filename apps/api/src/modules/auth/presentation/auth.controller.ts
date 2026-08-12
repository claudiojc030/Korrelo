import { Body, Controller, Delete, Get, Param, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { apiError } from "../../../infrastructure/api-error";
import { RegisterFirstUserUseCase } from "../application/register-first-user.use-case";
import { LoginUseCase } from "../application/login.use-case";
import { HasUserUseCase } from "../application/has-user.use-case";
import { SetupTwoFactorUseCase } from "../application/setup-two-factor.use-case";
import { EnableTwoFactorUseCase } from "../application/enable-two-factor.use-case";
import { DisableTwoFactorUseCase } from "../application/disable-two-factor.use-case";
import { GetTwoFactorStatusUseCase } from "../application/get-two-factor-status.use-case";
import { RefreshAccessTokenUseCase } from "../application/refresh-access-token.use-case";
import { LogoutUseCase } from "../application/logout.use-case";
import { ListActiveSessionsUseCase } from "../application/list-active-sessions.use-case";
import { RevokeSessionUseCase } from "../application/revoke-session.use-case";
import { AuthCredentialsDto } from "./auth-credentials.dto";
import { EnableTwoFactorDto } from "./enable-two-factor.dto";
import { DisableTwoFactorDto } from "./disable-two-factor.dto";
import { Public } from "./public.decorator";
import {
  TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  buildTokenCookieOptions,
  buildRefreshTokenCookieOptions,
} from "./token-cookie";

const AUTH_ATTEMPT_LIMIT = { default: { ttl: 60_000, limit: 5 } };

// Num servidor escutando em socket dual-stack (IPv4+IPv6), o Node reporta
// endereço IPv4 prefixado como "::ffff:1.2.3.4" (formato IPv4-mapped IPv6).
// Tira o prefixo só pra exibir/gravar um IP legível, sem mudar o valor real.
function normalizeIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  return ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
}

@Controller("auth")
export class AuthController {
  constructor(
    private readonly registerFirstUser: RegisterFirstUserUseCase,
    private readonly login: LoginUseCase,
    private readonly hasUser: HasUserUseCase,
    private readonly setupTwoFactor: SetupTwoFactorUseCase,
    private readonly enableTwoFactor: EnableTwoFactorUseCase,
    private readonly disableTwoFactor: DisableTwoFactorUseCase,
    private readonly getTwoFactorStatus: GetTwoFactorStatusUseCase,
    private readonly refreshAccessToken: RefreshAccessTokenUseCase,
    private readonly logoutUseCase: LogoutUseCase,
    private readonly listActiveSessions: ListActiveSessionsUseCase,
    private readonly revokeSession: RevokeSessionUseCase,
  ) {}

  @Public()
  @Get("has-user")
  async hasUserEndpoint() {
    return { hasUser: await this.hasUser.execute() };
  }

  @Public()
  @Throttle(AUTH_ATTEMPT_LIMIT)
  @Post("register")
  async register(
    @Body() dto: AuthCredentialsDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.registerFirstUser.execute({
      ...dto,
      userAgent: req.get("user-agent") ?? null,
      ipAddress: normalizeIp(req.ip),
    });
    res.cookie(TOKEN_COOKIE, result.accessToken, buildTokenCookieOptions(req.secure));
    res.cookie(REFRESH_TOKEN_COOKIE, result.refreshToken, buildRefreshTokenCookieOptions(req.secure));
    return { accessToken: result.accessToken, username: result.username };
  }

  @Public()
  @Throttle(AUTH_ATTEMPT_LIMIT)
  @Post("login")
  async loginEndpoint(
    @Body() dto: AuthCredentialsDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.login.execute({
      ...dto,
      userAgent: req.get("user-agent") ?? null,
      ipAddress: normalizeIp(req.ip),
    });
    if (result.accessToken && result.refreshToken) {
      res.cookie(TOKEN_COOKIE, result.accessToken, buildTokenCookieOptions(req.secure));
      res.cookie(REFRESH_TOKEN_COOKIE, result.refreshToken, buildRefreshTokenCookieOptions(req.secure));
    }
    return { requiresTwoFactor: result.requiresTwoFactor, accessToken: result.accessToken, username: result.username };
  }

  @Public()
  @Post("refresh")
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rawToken = req.cookies?.[REFRESH_TOKEN_COOKIE];
    if (!rawToken) {
      res.clearCookie(TOKEN_COOKIE, { path: "/" });
      res.clearCookie(REFRESH_TOKEN_COOKIE, { path: "/" });
      throw new UnauthorizedException(apiError("SESSION_EXPIRED", "Sessão expirada. Faça login novamente."));
    }

    const result = await this.refreshAccessToken.execute(rawToken, req.get("user-agent") ?? null, normalizeIp(req.ip));
    res.cookie(TOKEN_COOKIE, result.accessToken, buildTokenCookieOptions(req.secure));
    // null só na janela de graça de reuso (corrida entre requisições
    // concorrentes): o cookie de refresh certo já foi setado por quem venceu
    // a corrida, mexer nele de novo aqui poderia sobrescrever com um valor
    // desatualizado dependendo da ordem de chegada das respostas.
    if (result.refreshToken) {
      res.cookie(REFRESH_TOKEN_COOKIE, result.refreshToken, buildRefreshTokenCookieOptions(req.secure));
    }
    return { ok: true };
  }

  @Post("logout")
  @Public()
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rawToken = req.cookies?.[REFRESH_TOKEN_COOKIE];
    await this.logoutUseCase.execute(rawToken);
    res.clearCookie(TOKEN_COOKIE, { path: "/" });
    res.clearCookie(REFRESH_TOKEN_COOKIE, { path: "/" });
    return { ok: true };
  }

  @Get("me")
  me(@Req() req: Request) {
    const user = (req as Request & { user?: { sub: string; username: string } }).user;
    return { username: user?.username ?? null };
  }

  @Get("sessions")
  async sessionsEndpoint(@Req() req: Request) {
    const user = (req as Request & { user?: { sub: string } }).user;
    const currentRawToken = req.cookies?.[REFRESH_TOKEN_COOKIE];
    return this.listActiveSessions.execute(user!.sub, currentRawToken);
  }

  @Delete("sessions/:id")
  async revokeSessionEndpoint(@Req() req: Request, @Param("id") id: string) {
    const user = (req as Request & { user?: { sub: string } }).user;
    await this.revokeSession.execute(user!.sub, id);
    return { ok: true };
  }

  @Get("2fa/status")
  twoFactorStatus(@Req() req: Request) {
    const user = (req as Request & { user?: { sub: string } }).user;
    return this.getTwoFactorStatus.execute(user!.sub);
  }

  @Post("2fa/setup")
  setupTwoFactorEndpoint(@Req() req: Request) {
    const user = (req as Request & { user?: { sub: string } }).user;
    return this.setupTwoFactor.execute(user!.sub);
  }

  @Post("2fa/enable")
  enableTwoFactorEndpoint(@Req() req: Request, @Body() dto: EnableTwoFactorDto) {
    const user = (req as Request & { user?: { sub: string } }).user;
    return this.enableTwoFactor.execute(user!.sub, dto.code);
  }

  @Post("2fa/disable")
  async disableTwoFactorEndpoint(@Req() req: Request, @Body() dto: DisableTwoFactorDto) {
    const user = (req as Request & { user?: { sub: string } }).user;
    await this.disableTwoFactor.execute(user!.sub, dto.password);
    return { ok: true };
  }
}
