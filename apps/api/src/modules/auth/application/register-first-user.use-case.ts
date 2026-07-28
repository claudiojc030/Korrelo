import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { User } from "../domain/user.entity";
import { USER_REPOSITORY, type UserRepository } from "../domain/user.repository";
import { PASSWORD_HASHER, type PasswordHasher } from "../domain/password-hasher";
import { TOKEN_SERVICE, type TokenService } from "../domain/token-service";

export interface RegisterFirstUserInput {
  email: string;
  password: string;
}

export interface AuthResult {
  accessToken: string;
  email: string;
}

@Injectable()
export class RegisterFirstUserUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly repository: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly passwordHasher: PasswordHasher,
    @Inject(TOKEN_SERVICE) private readonly tokenService: TokenService,
  ) {}

  async execute(input: RegisterFirstUserInput): Promise<AuthResult> {
    const existingCount = await this.repository.count();
    if (existingCount > 0) {
      throw new ConflictException(
        "Já existe uma conta configurada neste ForgeDesk. Use /auth/login.",
      );
    }

    const passwordHash = await this.passwordHasher.hash(input.password);
    const user = User.create(input.email, passwordHash);
    await this.repository.save(user);

    const accessToken = this.tokenService.sign({ sub: user.id, email: user.email });
    return { accessToken, email: user.email };
  }
}
