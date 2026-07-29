import { ConflictException } from "@nestjs/common";
import { RegisterFirstUserUseCase } from "./register-first-user.use-case";
import type { UserRepository } from "../domain/user.repository";
import type { PasswordHasher } from "../domain/password-hasher";
import type { TokenPairIssuer } from "./token-pair-issuer";

function buildUseCase(existingUserCount: number) {
  const repository: UserRepository = {
    count: jest.fn().mockResolvedValue(existingUserCount),
    findByUsername: jest.fn(),
    findFirst: jest.fn(),
    findById: jest.fn(),
    save: jest.fn().mockImplementation((user) => Promise.resolve(user)),
    update: jest.fn(),
  };
  const passwordHasher: PasswordHasher = {
    hash: jest.fn().mockResolvedValue("hashed-password"),
    compare: jest.fn(),
  };
  const tokenPairIssuer: TokenPairIssuer = {
    issue: jest.fn().mockResolvedValue({ accessToken: "signed-jwt-token", refreshToken: "raw-refresh-token" }),
  } as unknown as TokenPairIssuer;

  return {
    useCase: new RegisterFirstUserUseCase(repository, passwordHasher, tokenPairIssuer),
    repository,
    passwordHasher,
  };
}

describe("RegisterFirstUserUseCase", () => {
  it("cria o primeiro usuário quando não existe nenhum ainda", async () => {
    const { useCase, repository, passwordHasher } = buildUseCase(0);

    const result = await useCase.execute({ username: "admin", password: "senha-forte" });

    expect(passwordHasher.hash).toHaveBeenCalledWith("senha-forte");
    expect(repository.save).toHaveBeenCalled();
    expect(result).toEqual({
      accessToken: "signed-jwt-token",
      refreshToken: "raw-refresh-token",
      username: "admin",
    });
  });

  it("recusa criar uma segunda conta quando já existe um usuário", async () => {
    const { useCase, repository } = buildUseCase(1);

    await expect(
      useCase.execute({ username: "outro", password: "qualquer" }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.save).not.toHaveBeenCalled();
  });
});
