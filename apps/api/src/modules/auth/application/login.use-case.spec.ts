import { UnauthorizedException } from "@nestjs/common";
import { LoginUseCase } from "./login.use-case";
import { User } from "../domain/user.entity";
import type { UserRepository } from "../domain/user.repository";
import type { PasswordHasher } from "../domain/password-hasher";
import type { TokenService } from "../domain/token-service";

function buildUseCase(overrides?: {
  user?: User | null;
  passwordMatches?: boolean;
}) {
  const user = overrides?.user !== undefined ? overrides.user : User.create("admin@forgedesk.local", "hashed");

  const repository: UserRepository = {
    count: jest.fn(),
    findByEmail: jest.fn().mockResolvedValue(user),
    save: jest.fn(),
  };
  const passwordHasher: PasswordHasher = {
    hash: jest.fn(),
    compare: jest.fn().mockResolvedValue(overrides?.passwordMatches ?? true),
  };
  const tokenService: TokenService = {
    sign: jest.fn().mockReturnValue("signed-jwt-token"),
    verify: jest.fn(),
  };

  return {
    useCase: new LoginUseCase(repository, passwordHasher, tokenService),
    repository,
    passwordHasher,
    tokenService,
  };
}

describe("LoginUseCase", () => {
  it("retorna um access token quando as credenciais são válidas", async () => {
    const { useCase, tokenService } = buildUseCase({ passwordMatches: true });

    const result = await useCase.execute({ email: "admin@forgedesk.local", password: "correta" });

    expect(result).toEqual({ accessToken: "signed-jwt-token", email: "admin@forgedesk.local" });
    expect(tokenService.sign).toHaveBeenCalledWith(
      expect.objectContaining({ email: "admin@forgedesk.local" }),
    );
  });

  it("rejeita quando o usuário não existe", async () => {
    const { useCase } = buildUseCase({ user: null });

    await expect(
      useCase.execute({ email: "inexistente@forgedesk.local", password: "qualquer" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejeita quando a senha está incorreta", async () => {
    const { useCase } = buildUseCase({ passwordMatches: false });

    await expect(
      useCase.execute({ email: "admin@forgedesk.local", password: "errada" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
