import { UnauthorizedException } from "@nestjs/common";
import { LoginUseCase } from "./login.use-case";
import { User } from "../domain/user.entity";
import type { UserRepository } from "../domain/user.repository";
import type { PasswordHasher } from "../domain/password-hasher";
import type { TokenService } from "../domain/token-service";
import type { TwoFactorService } from "../domain/two-factor-service";

function buildUseCase(overrides?: {
  user?: User | null;
  passwordMatches?: boolean;
  twoFactorValid?: boolean;
}) {
  const user = overrides?.user !== undefined ? overrides.user : User.create("admin@forgedesk.local", "hashed");

  const repository: UserRepository = {
    count: jest.fn(),
    findByEmail: jest.fn().mockResolvedValue(user),
    findFirst: jest.fn(),
    findById: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
  };
  const passwordHasher: PasswordHasher = {
    hash: jest.fn(),
    compare: jest.fn().mockResolvedValue(overrides?.passwordMatches ?? true),
  };
  const tokenService: TokenService = {
    sign: jest.fn().mockReturnValue("signed-jwt-token"),
    verify: jest.fn(),
  };
  const twoFactorService: TwoFactorService = {
    generateSecret: jest.fn(),
    buildOtpAuthUrl: jest.fn(),
    generateQrCodeDataUrl: jest.fn(),
    verifyToken: jest.fn().mockResolvedValue(overrides?.twoFactorValid ?? true),
    generateBackupCodes: jest.fn(),
  };

  return {
    useCase: new LoginUseCase(repository, passwordHasher, tokenService, twoFactorService),
    repository,
    passwordHasher,
    tokenService,
    twoFactorService,
  };
}

describe("LoginUseCase", () => {
  it("retorna um access token quando as credenciais são válidas", async () => {
    const { useCase, tokenService } = buildUseCase({ passwordMatches: true });

    const result = await useCase.execute({ email: "admin@forgedesk.local", password: "correta" });

    expect(result).toEqual({ requiresTwoFactor: false, accessToken: "signed-jwt-token", email: "admin@forgedesk.local" });
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

  it("pede o segundo fator quando 2FA está ativado e nenhum código foi enviado", async () => {
    const userWith2fa = User.create("admin@forgedesk.local", "hashed").withTwoFactorEnabled(["hash1"]);
    const { useCase } = buildUseCase({ user: userWith2fa });

    const result = await useCase.execute({ email: "admin@forgedesk.local", password: "correta" });

    expect(result).toEqual({ requiresTwoFactor: true });
  });

  it("aceita login com 2FA quando o código TOTP é válido", async () => {
    const userWith2fa = User.create("admin@forgedesk.local", "hashed").withTwoFactorEnabled(["hash1"]);
    const { useCase } = buildUseCase({ user: userWith2fa, twoFactorValid: true });

    const result = await useCase.execute({ email: "admin@forgedesk.local", password: "correta", twoFactorCode: "123456" });

    expect(result.accessToken).toBe("signed-jwt-token");
    expect(result.requiresTwoFactor).toBe(false);
  });

  it("rejeita login com 2FA quando o código é inválido e não bate com nenhum backup code", async () => {
    const userWith2fa = User.create("admin@forgedesk.local", "hashed").withTwoFactorEnabled(["hash1"]);
    const { useCase, passwordHasher } = buildUseCase({ user: userWith2fa, twoFactorValid: false });
    (passwordHasher.compare as jest.Mock).mockImplementation((plainText: string, hash: string) =>
      Promise.resolve(plainText === "correta" && hash === "hashed"),
    );

    await expect(
      useCase.execute({ email: "admin@forgedesk.local", password: "correta", twoFactorCode: "000000" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
