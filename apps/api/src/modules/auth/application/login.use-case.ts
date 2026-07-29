import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { User } from "../domain/user.entity";
import { USER_REPOSITORY, type UserRepository } from "../domain/user.repository";
import { PASSWORD_HASHER, type PasswordHasher } from "../domain/password-hasher";
import { TWO_FACTOR_SERVICE, type TwoFactorService } from "../domain/two-factor-service";
import { TokenPairIssuer } from "./token-pair-issuer";

export interface LoginInput {
  email: string;
  password: string;
  twoFactorCode?: string;
  userAgent?: string | null;
  ipAddress?: string | null;
}

export interface LoginResult {
  requiresTwoFactor: boolean;
  accessToken?: string;
  refreshToken?: string;
  email?: string;
}

@Injectable()
export class LoginUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly repository: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly passwordHasher: PasswordHasher,
    @Inject(TWO_FACTOR_SERVICE) private readonly twoFactorService: TwoFactorService,
    private readonly tokenPairIssuer: TokenPairIssuer,
  ) {}

  async execute(input: LoginInput): Promise<LoginResult> {
    const user = await this.repository.findByEmail(input.email);
    if (!user) {
      throw new UnauthorizedException("E-mail ou senha inválidos.");
    }

    const passwordMatches = await this.passwordHasher.compare(input.password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException("E-mail ou senha inválidos.");
    }

    if (user.twoFactorEnabled) {
      if (!input.twoFactorCode) {
        return { requiresTwoFactor: true };
      }

      const validTotp =
        user.twoFactorSecret != null && (await this.twoFactorService.verifyToken(user.twoFactorSecret, input.twoFactorCode));

      if (!validTotp) {
        const backupMatch = await this.tryConsumeBackupCode(user, input.twoFactorCode);
        if (!backupMatch) {
          throw new UnauthorizedException("Código de verificação inválido.");
        }
      }
    }

    const { accessToken, refreshToken } = await this.tokenPairIssuer.issue(
      user.id,
      user.email,
      input.userAgent ?? null,
      input.ipAddress ?? null,
    );
    return { requiresTwoFactor: false, accessToken, refreshToken, email: user.email };
  }

  private async tryConsumeBackupCode(user: User, code: string): Promise<boolean> {
    for (let i = 0; i < user.twoFactorBackupCodes.length; i++) {
      const matches = await this.passwordHasher.compare(code, user.twoFactorBackupCodes[i]);
      if (matches) {
        // Código de backup é de uso único, então remove assim que consumido.
        const remaining = [...user.twoFactorBackupCodes];
        remaining.splice(i, 1);
        await this.repository.update(user.withBackupCodes(remaining));
        return true;
      }
    }
    return false;
  }
}
