import { Body, Controller, Get, Post } from "@nestjs/common";
import { RegisterFirstUserUseCase } from "../application/register-first-user.use-case";
import { LoginUseCase } from "../application/login.use-case";
import { HasUserUseCase } from "../application/has-user.use-case";
import { AuthCredentialsDto } from "./auth-credentials.dto";
import { Public } from "./public.decorator";

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
  @Post("register")
  register(@Body() dto: AuthCredentialsDto) {
    return this.registerFirstUser.execute(dto);
  }

  @Public()
  @Post("login")
  loginEndpoint(@Body() dto: AuthCredentialsDto) {
    return this.login.execute(dto);
  }
}
