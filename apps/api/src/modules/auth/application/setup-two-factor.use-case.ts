import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { USER_REPOSITORY, type UserRepository } from "../domain/user.repository";
import { TWO_FACTOR_SERVICE, type TwoFactorService } from "../domain/two-factor-service";

export interface TwoFactorSetupResult {
  secret: string;
  otpAuthUrl: string;
  qrCodeDataUrl: string;
}

@Injectable()
export class SetupTwoFactorUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly userRepository: UserRepository,
    @Inject(TWO_FACTOR_SERVICE) private readonly twoFactorService: TwoFactorService,
  ) {}

  async execute(userId: string): Promise<TwoFactorSetupResult> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new NotFoundException("Usuário não encontrado.");
    }
    if (user.twoFactorEnabled) {
      throw new BadRequestException("2FA já está ativado nesta conta. Desative antes de reconfigurar.");
    }

    const secret = this.twoFactorService.generateSecret();
    const otpAuthUrl = this.twoFactorService.buildOtpAuthUrl(user.email, secret);
    const qrCodeDataUrl = await this.twoFactorService.generateQrCodeDataUrl(otpAuthUrl);

    // Guarda o segredo já, mas twoFactorEnabled só vira true depois que o
    // usuário provar (via EnableTwoFactorUseCase) que configurou o app
    // autenticador corretamente — evita ficar "meio ativado" se a pessoa
    // fechar a tela antes de confirmar.
    await this.userRepository.update(user.withPendingTwoFactorSecret(secret));

    return { secret, otpAuthUrl, qrCodeDataUrl };
  }
}
