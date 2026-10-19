import { NotFoundException, UnauthorizedException } from "@nestjs/common";
import type { CoreEnvRepository, CoreEnvVar } from "../domain/core-env.repository";
import { SECRET_MASK } from "../domain/core-env-secrets";
import { ListCoreEnvUseCase } from "./list-core-env.use-case";
import { SetCoreEnvVarUseCase } from "./set-core-env-var.use-case";
import { SetCoreEnvBulkUseCase } from "./set-core-env-bulk.use-case";
import { RevealCoreEnvVarUseCase } from "./reveal-core-env-var.use-case";
import { User } from "../../auth/domain/user.entity";
import type { UserRepository } from "../../auth/domain/user.repository";
import type { PasswordHasher } from "../../auth/domain/password-hasher";

class InMemoryCoreEnvRepository implements CoreEnvRepository {
  readonly values = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) this.values.set(key, value);
  }

  async list(): Promise<CoreEnvVar[]> {
    return [...this.values.entries()].map(([key, value]) => ({ key, value }));
  }

  async getValue(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async upsertOne(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async upsertMany(values: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(values)) this.values.set(key, value);
  }
}

class FakeUserRepository implements UserRepository {
  async count(): Promise<number> {
    return 1;
  }
  async findByUsername(): Promise<User | null> {
    return this.user;
  }
  async findFirst(): Promise<User | null> {
    return this.user;
  }
  async findById(): Promise<User | null> {
    return this.user;
  }
  async save(user: User): Promise<User> {
    return user;
  }
  async update(user: User): Promise<User> {
    return user;
  }
  readonly user = new User("user-1", "admin", "hash-da-senha", null, false, [], new Date());
}

class FakePasswordHasher implements PasswordHasher {
  async hash(): Promise<string> {
    return "hash";
  }
  async compare(plainText: string, hash: string): Promise<boolean> {
    return plainText === "senha-correta" && hash === "hash-da-senha";
  }
}

describe("variáveis de ambiente do Core", () => {
  const initial = {
    JWT_SECRET: "segredo-jwt",
    ENV_ENCRYPTION_KEY: "segredo-cripto",
    GITHUB_APP_ID: "123456",
    PORT: "3001",
  };

  it("a listagem NUNCA devolve o valor de um segredo", async () => {
    const repository = new InMemoryCoreEnvRepository(initial);
    const useCase = new ListCoreEnvUseCase(repository);

    const vars = await useCase.execute();

    const byKey = Object.fromEntries(vars.map((v) => [v.key, v]));
    expect(byKey.JWT_SECRET.value).toBe(SECRET_MASK);
    expect(byKey.ENV_ENCRYPTION_KEY.value).toBe(SECRET_MASK);
    expect(byKey.JWT_SECRET.masked).toBe(true);
    // O que não é segredo continua visível (o admin precisa do App ID).
    expect(byKey.GITHUB_APP_ID.value).toBe("123456");
    expect(byKey.GITHUB_APP_ID.masked).toBe(false);
    expect(byKey.PORT.value).toBe("3001");

    // Nenhum valor real de segredo vazou na resposta.
    const serialized = JSON.stringify(vars);
    expect(serialized).not.toContain("segredo-jwt");
    expect(serialized).not.toContain("segredo-cripto");
  });

  it("salvar a tela não sobrescreve o segredo com a máscara", async () => {
    const repository = new InMemoryCoreEnvRepository(initial);
    const useCase = new SetCoreEnvVarUseCase(repository);

    const result = await useCase.execute("JWT_SECRET", SECRET_MASK);

    expect(result.written).toBe(false);
    expect(await repository.getValue("JWT_SECRET")).toBe("segredo-jwt");
  });

  it("salvar um valor novo realmente grava (rotacionar o segredo)", async () => {
    const repository = new InMemoryCoreEnvRepository(initial);
    const useCase = new SetCoreEnvVarUseCase(repository);

    const result = await useCase.execute("JWT_SECRET", "novo-segredo");

    expect(result.written).toBe(true);
    expect(await repository.getValue("JWT_SECRET")).toBe("novo-segredo");
  });

  it("a gravação em lote ignora máscaras de chaves sensíveis", async () => {
    const repository = new InMemoryCoreEnvRepository(initial);
    const useCase = new SetCoreEnvBulkUseCase(repository);

    const result = await useCase.execute(
      ["JWT_SECRET=" + SECRET_MASK, "ENV_ENCRYPTION_KEY=" + SECRET_MASK, "PORT=3001"].join("\n"),
    );

    expect(result.count).toBe(1);
    expect(result.skipped).toBe(2);
    expect(await repository.getValue("JWT_SECRET")).toBe("segredo-jwt");
    expect(await repository.getValue("ENV_ENCRYPTION_KEY")).toBe("segredo-cripto");
    expect(await repository.getValue("PORT")).toBe("3001");
  });

  it("revelar exige a senha do administrador", async () => {
    const repository = new InMemoryCoreEnvRepository(initial);
    const useCase = new RevealCoreEnvVarUseCase(
      new FakeUserRepository(),
      new FakePasswordHasher(),
      repository,
    );

    await expect(useCase.execute("user-1", "JWT_SECRET", "senha-errada")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    const revealed = await useCase.execute("user-1", "JWT_SECRET", "senha-correta");
    expect(revealed).toEqual({ key: "JWT_SECRET", value: "segredo-jwt" });
  });

  it("revelar uma variável inexistente devolve 404", async () => {
    const repository = new InMemoryCoreEnvRepository(initial);
    const useCase = new RevealCoreEnvVarUseCase(
      new FakeUserRepository(),
      new FakePasswordHasher(),
      repository,
    );

    await expect(useCase.execute("user-1", "NAO_EXISTE", "senha-correta")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
