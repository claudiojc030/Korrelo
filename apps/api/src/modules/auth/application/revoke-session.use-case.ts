import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { REFRESH_TOKEN_REPOSITORY, type RefreshTokenRepository } from "../domain/refresh-token.repository";

@Injectable()
export class RevokeSessionUseCase {
  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokenRepository: RefreshTokenRepository,
  ) {}

  async execute(userId: string, sessionId: string): Promise<void> {
    const session = await this.refreshTokenRepository.findById(sessionId);
    if (!session) {
      throw new NotFoundException(apiError("SESSION_NOT_FOUND", "Sessão não encontrada."));
    }
    if (session.userId !== userId) {
      throw new ForbiddenException(apiError("SESSION_NOT_OWNED", "Essa sessão não pertence a esta conta."));
    }

    if (session.revokedAt === null) {
      await this.refreshTokenRepository.save(session.revoke());
    }
  }
}
