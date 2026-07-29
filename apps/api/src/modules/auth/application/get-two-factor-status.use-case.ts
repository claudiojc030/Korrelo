import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { USER_REPOSITORY, type UserRepository } from "../domain/user.repository";

@Injectable()
export class GetTwoFactorStatusUseCase {
  constructor(@Inject(USER_REPOSITORY) private readonly userRepository: UserRepository) {}

  async execute(userId: string): Promise<{ enabled: boolean }> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new NotFoundException(apiError("USER_NOT_FOUND", "Usuário não encontrado."));
    }
    return { enabled: user.twoFactorEnabled };
  }
}
