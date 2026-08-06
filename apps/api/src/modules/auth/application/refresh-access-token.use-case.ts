import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { USER_REPOSITORY, type UserRepository } from "../domain/user.repository";
import { REFRESH_TOKEN_REPOSITORY, type RefreshTokenRepository } from "../domain/refresh-token.repository";
import { TOKEN_SERVICE, type TokenService } from "../domain/token-service";
import { hashRefreshToken } from "../infrastructure/refresh-token-crypto";
import { TokenPairIssuer } from "./token-pair-issuer";

export interface RefreshResult {
  accessToken: string;
  // null quando essa chamada só ganhou um access token novo dentro da janela
  // de graça de reuso (ver RefreshToken.wasJustReplacedWithinGrace) - nesse
  // caso não existe refresh token novo pra setar cookie nenhum, o cookie que
  // já está no navegador (setado pela requisição que venceu a corrida) continua valendo.
  refreshToken: string | null;
  username: string;
}

@Injectable()
export class RefreshAccessTokenUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly userRepository: UserRepository,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokenRepository: RefreshTokenRepository,
    @Inject(TOKEN_SERVICE) private readonly tokenService: TokenService,
    private readonly tokenPairIssuer: TokenPairIssuer,
  ) {}

  async execute(
    rawToken: string,
    userAgent: string | null = null,
    ipAddress: string | null = null,
  ): Promise<RefreshResult> {
    const stored = await this.refreshTokenRepository.findByTokenHash(hashRefreshToken(rawToken));
    if (!stored) {
      throw new UnauthorizedException(apiError("SESSION_EXPIRED", "Sessão expirada. Faça login novamente."));
    }

    if (!stored.isValid()) {
      // Corrida entre requisições concorrentes (comum: o Next.js dispara
      // várias sub-requisições em paralelo pra uma navegação só). Se esse
      // token específico acabou de ser rotacionado por OUTRA requisição
      // (dentro da janela de graça), não trata como sessão roubada: só emite
      // um access token novo pro usuário já autenticado da rotação vencedora,
      // sem mexer no refresh token (o cookie certo já foi setado por ela).
      if (stored.wasJustReplacedWithinGrace() && stored.replacedByTokenHash) {
        const replacement = await this.refreshTokenRepository.findByTokenHash(stored.replacedByTokenHash);
        if (replacement?.isValid()) {
          const user = await this.userRepository.findById(replacement.userId);
          if (user) {
            const accessToken = this.tokenService.sign({ sub: user.id, username: user.username });
            return { accessToken, refreshToken: null, username: user.username };
          }
        }
      }
      throw new UnauthorizedException(apiError("SESSION_EXPIRED", "Sessão expirada. Faça login novamente."));
    }

    const user = await this.userRepository.findById(stored.userId);
    if (!user) {
      throw new UnauthorizedException(apiError("SESSION_EXPIRED", "Sessão expirada. Faça login novamente."));
    }

    const { accessToken, refreshToken } = await this.tokenPairIssuer.issue(
      user.id,
      user.username,
      userAgent ?? stored.userAgent,
      ipAddress ?? stored.ipAddress,
    );
    // Rotação: o token usado é revogado antes de emitir o novo par, então
    // reuso de um refresh token antigo (ex.: token roubado já consumido pelo
    // dono legítimo) é detectado e rejeitado depois da janela de graça acima.
    await this.refreshTokenRepository.save(stored.revoke(hashRefreshToken(refreshToken)));

    return { accessToken, refreshToken, username: user.username };
  }
}
