import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthController } from "./presentation/auth.controller";
import { JwtAuthGuard } from "./presentation/jwt-auth.guard";
import { RegisterFirstUserUseCase } from "./application/register-first-user.use-case";
import { LoginUseCase } from "./application/login.use-case";
import { HasUserUseCase } from "./application/has-user.use-case";
import { SetupTwoFactorUseCase } from "./application/setup-two-factor.use-case";
import { EnableTwoFactorUseCase } from "./application/enable-two-factor.use-case";
import { DisableTwoFactorUseCase } from "./application/disable-two-factor.use-case";
import { GetTwoFactorStatusUseCase } from "./application/get-two-factor-status.use-case";
import { RefreshAccessTokenUseCase } from "./application/refresh-access-token.use-case";
import { LogoutUseCase } from "./application/logout.use-case";
import { TokenPairIssuer } from "./application/token-pair-issuer";
import { PrismaUserRepository } from "./infrastructure/prisma-user.repository";
import { PrismaRefreshTokenRepository } from "./infrastructure/prisma-refresh-token.repository";
import { BcryptPasswordHasher } from "./infrastructure/bcrypt-password-hasher";
import { JsonWebTokenService } from "./infrastructure/jsonwebtoken-token-service";
import { OtplibTwoFactorService } from "./infrastructure/otplib-two-factor.service";
import { USER_REPOSITORY } from "./domain/user.repository";
import { PASSWORD_HASHER } from "./domain/password-hasher";
import { TOKEN_SERVICE } from "./domain/token-service";
import { TWO_FACTOR_SERVICE } from "./domain/two-factor-service";
import { REFRESH_TOKEN_REPOSITORY } from "./domain/refresh-token.repository";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";

@Module({
  controllers: [AuthController],
  providers: [
    PrismaService,
    RegisterFirstUserUseCase,
    LoginUseCase,
    HasUserUseCase,
    SetupTwoFactorUseCase,
    EnableTwoFactorUseCase,
    DisableTwoFactorUseCase,
    GetTwoFactorStatusUseCase,
    RefreshAccessTokenUseCase,
    LogoutUseCase,
    TokenPairIssuer,
    { provide: USER_REPOSITORY, useClass: PrismaUserRepository },
    { provide: PASSWORD_HASHER, useClass: BcryptPasswordHasher },
    { provide: TOKEN_SERVICE, useClass: JsonWebTokenService },
    { provide: TWO_FACTOR_SERVICE, useClass: OtplibTwoFactorService },
    { provide: REFRESH_TOKEN_REPOSITORY, useClass: PrismaRefreshTokenRepository },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [TOKEN_SERVICE, USER_REPOSITORY],
})
export class AuthModule {}
