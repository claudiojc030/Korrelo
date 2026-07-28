import { ConflictException } from "@nestjs/common";
import { RegisterFirstUserUseCase } from "./register-first-user.use-case";
import type { UserRepository } from "../domain/user.repository";
import type { PasswordHasher } from "../domain/password-hasher";
import type { TokenService } from "../domain/token-service";

function buildUseCase(existingUserCount: number) {
  const repository: UserRepository = {
    count: jest.fn().mockResolvedValue(existingUserCount),
    findByEmail: jest.fn(),
    findFirst: jest.fn(),
    findById: jest.fn(),
    save: jest.fn().mockImplementation((user) => Promise.resolve(user)),
    update: jest.fn(),
  };
  const passwordHasher: PasswordHasher = {
    hash: jest.fn().mockResolvedValue("hashed-password"),
    compare: jest.fn(),
  };
  const tokenService: TokenService = {
    sign: jest.fn().mockReturnValue("signed-jwt-token"),
    verify: jest.fn(),
  };

  return {
    useCase: new RegisterFirstUserUseCase(repository, passwordHasher, tokenService),
    repository,
    passwordHasher,
  };
}

describe("RegisterFirstUserUseCase", () => {
  it("cria o primeiro usuário quando não existe nenhum ainda", async () => {
    const { useCase, repository, passwordHasher } = buildUseCase(0);

    const result = await useCase.execute({ email: "admin@forgedesk.local", password: "senha-forte" });

    expect(passwordHasher.hash).toHaveBeenCalledWith("senha-forte");
    expect(repository.save).toHaveBeenCalled();
    expect(result).toEqual({ accessToken: "signed-jwt-token", email: "admin@forgedesk.local" });
  });

  it("recusa criar uma segunda conta quando já existe um usuário", async () => {
    const { useCase, repository } = buildUseCase(1);

    await expect(
      useCase.execute({ email: "outro@forgedesk.local", password: "qualquer" }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.save).not.toHaveBeenCalled();
  });
});
