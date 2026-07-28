import { BadRequestException, Inject, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { USER_REPOSITORY, type UserRepository } from "../domain/user.repository";
import { PASSWORD_HASHER, type PasswordHasher } from "../domain/password-hasher";

@Injectable()
export class DisableTwoFactorUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly userRepository: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly passwordHasher: PasswordHasher,
  ) {}

  async execute(userId: string, password: string): Promise<void> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new NotFoundException("Usuário não encontrado.");
    }
    if (!user.twoFactorEnabled) {
      throw new BadRequestException("2FA não está ativado nesta conta.");
    }

    const passwordMatches = await this.passwordHasher.compare(password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException("Senha incorreta.");
    }

    await this.userRepository.update(user.withTwoFactorDisabled());
  }
}
