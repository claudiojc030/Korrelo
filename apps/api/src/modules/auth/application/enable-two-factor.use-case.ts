import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { USER_REPOSITORY, type UserRepository } from "../domain/user.repository";
import { TWO_FACTOR_SERVICE, type TwoFactorService } from "../domain/two-factor-service";
import { PASSWORD_HASHER, type PasswordHasher } from "../domain/password-hasher";

const BACKUP_CODE_COUNT = 8;

@Injectable()
export class EnableTwoFactorUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly userRepository: UserRepository,
    @Inject(TWO_FACTOR_SERVICE) private readonly twoFactorService: TwoFactorService,
    @Inject(PASSWORD_HASHER) private readonly passwordHasher: PasswordHasher,
  ) {}

  async execute(userId: string, code: string): Promise<{ backupCodes: string[] }> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new NotFoundException("Usuário não encontrado.");
    }
    if (!user.twoFactorSecret) {
      throw new BadRequestException("Nenhuma configuração de 2FA pendente. Chame /auth/2fa/setup primeiro.");
    }

    const valid = await this.twoFactorService.verifyToken(user.twoFactorSecret, code);
    if (!valid) {
      throw new BadRequestException("Código inválido. Confira o horário do seu celular e tente de novo.");
    }

    const backupCodes = this.twoFactorService.generateBackupCodes(BACKUP_CODE_COUNT);
    const hashedCodes = await Promise.all(backupCodes.map((c) => this.passwordHasher.hash(c)));

    await this.userRepository.update(user.withTwoFactorEnabled(hashedCodes));

    return { backupCodes };
  }
}
