import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { USER_REPOSITORY, type UserRepository } from "../domain/user.repository";

@Injectable()
export class GetTwoFactorStatusUseCase {
  constructor(@Inject(USER_REPOSITORY) private readonly userRepository: UserRepository) {}

  async execute(userId: string): Promise<{ enabled: boolean }> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new NotFoundException("Usuário não encontrado.");
    }
    return { enabled: user.twoFactorEnabled };
  }
}
