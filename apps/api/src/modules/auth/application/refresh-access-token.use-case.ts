import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { USER_REPOSITORY, type UserRepository } from "../domain/user.repository";
import { REFRESH_TOKEN_REPOSITORY, type RefreshTokenRepository } from "../domain/refresh-token.repository";
import { TOKEN_SERVICE, type TokenService } from "../domain/token-service";
import { RefreshToken } from "../domain/refresh-token.entity";
import { generateRefreshToken, hashRefreshToken, REFRESH_TOKEN_TTL_DAYS } from "../infrastructure/refresh-token-crypto";

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

    const refreshToken = generateRefreshToken();
    const refreshTokenHash = hashRefreshToken(refreshToken);

    // Revogação atômica (WHERE revokedAt IS NULL) ANTES de persistir o token
    // novo: se outra sub-requisição paralela da mesma navegação (mesmo
    // refresh cookie antigo) já rotacionou esse token entre o find() acima e
    // agora, won == false e a gente nem chega a criar a linha nova - antes
    // disso, o token novo já tinha sido salvo incondicionalmente e ficava
    // órfão, nunca revogado, "ativo" pra sempre na lista de sessões.
    const won = await this.refreshTokenRepository.revokeIfActive(stored.id, refreshTokenHash);
    if (!won) {
      const winner = await this.refreshTokenRepository.findById(stored.id);
      const actual = winner?.replacedByTokenHash
        ? await this.refreshTokenRepository.findByTokenHash(winner.replacedByTokenHash)
        : null;
      if (actual?.isValid()) {
        const accessToken = this.tokenService.sign({ sub: user.id, username: user.username });
        return { accessToken, refreshToken: null, username: user.username };
      }
      throw new UnauthorizedException(apiError("SESSION_EXPIRED", "Sessão expirada. Faça login novamente."));
    }

    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    await this.refreshTokenRepository.save(
      RefreshToken.create(user.id, refreshTokenHash, expiresAt, userAgent ?? stored.userAgent, ipAddress ?? stored.ipAddress),
    );
    const accessToken = this.tokenService.sign({ sub: user.id, username: user.username });

    return { accessToken, refreshToken, username: user.username };
  }
}
