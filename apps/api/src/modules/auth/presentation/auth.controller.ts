import { Body, Controller, Get, Post, Req, Res } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { RegisterFirstUserUseCase } from "../application/register-first-user.use-case";
import { LoginUseCase } from "../application/login.use-case";
import { HasUserUseCase } from "../application/has-user.use-case";
import { AuthCredentialsDto } from "./auth-credentials.dto";
import { Public } from "./public.decorator";
import { TOKEN_COOKIE, buildTokenCookieOptions } from "./token-cookie";

const AUTH_ATTEMPT_LIMIT = { default: { ttl: 60_000, limit: 5 } };

@Controller("auth")
export class AuthController {
  constructor(
    private readonly registerFirstUser: RegisterFirstUserUseCase,
    private readonly login: LoginUseCase,
    private readonly hasUser: HasUserUseCase,
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
    const result = await this.registerFirstUser.execute(dto);
    res.cookie(TOKEN_COOKIE, result.accessToken, buildTokenCookieOptions(req.secure));
    return result;
  }

  @Public()
  @Throttle(AUTH_ATTEMPT_LIMIT)
  @Post("login")
  async loginEndpoint(
    @Body() dto: AuthCredentialsDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.login.execute(dto);
    res.cookie(TOKEN_COOKIE, result.accessToken, buildTokenCookieOptions(req.secure));
    return result;
  }

  @Post("logout")
  @Public()
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.clearCookie(TOKEN_COOKIE, { path: "/" });
    return { ok: true };
  }

  @Get("me")
  me(@Req() req: Request) {
    const user = (req as Request & { user?: { sub: string; email: string } }).user;
    return { email: user?.email ?? null };
  }
}
