import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { USER_REPOSITORY, type UserRepository } from "../domain/user.repository";
import { PASSWORD_HASHER, type PasswordHasher } from "../domain/password-hasher";
import { TOKEN_SERVICE, type TokenService } from "../domain/token-service";
import type { AuthResult } from "./register-first-user.use-case";

export interface LoginInput {
  email: string;
  password: string;
}

@Injectable()
export class LoginUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly repository: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly passwordHasher: PasswordHasher,
    @Inject(TOKEN_SERVICE) private readonly tokenService: TokenService,
  ) {}

  async execute(input: LoginInput): Promise<AuthResult> {
    const user = await this.repository.findByEmail(input.email);
    if (!user) {
      throw new UnauthorizedException("E-mail ou senha inválidos.");
    }

    const passwordMatches = await this.passwordHasher.compare(input.password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException("E-mail ou senha inválidos.");
    }

    const accessToken = this.tokenService.sign({ sub: user.id, email: user.email });
    return { accessToken, email: user.email };
  }
}
