import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { User } from "../domain/user.entity";
import { USER_REPOSITORY, type UserRepository } from "../domain/user.repository";
import { PASSWORD_HASHER, type PasswordHasher } from "../domain/password-hasher";
import { TokenPairIssuer } from "./token-pair-issuer";

export interface RegisterFirstUserInput {
  email: string;
  password: string;
  userAgent?: string | null;
  ipAddress?: string | null;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  email: string;
}

@Injectable()
export class RegisterFirstUserUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly repository: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly passwordHasher: PasswordHasher,
    private readonly tokenPairIssuer: TokenPairIssuer,
  ) {}

  async execute(input: RegisterFirstUserInput): Promise<AuthResult> {
    const existingCount = await this.repository.count();
    if (existingCount > 0) {
      throw new ConflictException(
        apiError("ACCOUNT_ALREADY_EXISTS", "Já existe uma conta configurada neste Korrelo. Use /auth/login."),
      );
    }

    const passwordHash = await this.passwordHasher.hash(input.password);
    const user = User.create(input.email, passwordHash);
    await this.repository.save(user);

    const { accessToken, refreshToken } = await this.tokenPairIssuer.issue(
      user.id,
      user.email,
      input.userAgent ?? null,
      input.ipAddress ?? null,
    );
    return { accessToken, refreshToken, email: user.email };
  }
}
