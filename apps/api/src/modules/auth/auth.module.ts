import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthController } from "./presentation/auth.controller";
import { JwtAuthGuard } from "./presentation/jwt-auth.guard";
import { RegisterFirstUserUseCase } from "./application/register-first-user.use-case";
import { LoginUseCase } from "./application/login.use-case";
import { HasUserUseCase } from "./application/has-user.use-case";
import { PrismaUserRepository } from "./infrastructure/prisma-user.repository";
import { BcryptPasswordHasher } from "./infrastructure/bcrypt-password-hasher";
import { JsonWebTokenService } from "./infrastructure/jsonwebtoken-token-service";
import { USER_REPOSITORY } from "./domain/user.repository";
import { PASSWORD_HASHER } from "./domain/password-hasher";
import { TOKEN_SERVICE } from "./domain/token-service";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";

@Module({
  controllers: [AuthController],
  providers: [
    PrismaService,
    RegisterFirstUserUseCase,
    LoginUseCase,
    HasUserUseCase,
    { provide: USER_REPOSITORY, useClass: PrismaUserRepository },
    { provide: PASSWORD_HASHER, useClass: BcryptPasswordHasher },
    { provide: TOKEN_SERVICE, useClass: JsonWebTokenService },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [TOKEN_SERVICE, USER_REPOSITORY],
})
export class AuthModule {}
