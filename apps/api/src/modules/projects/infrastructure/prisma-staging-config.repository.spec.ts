import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { EnvVarCipher } from "../../../infrastructure/crypto/env-var-cipher";
import { PrismaStagingConfigRepository } from "./prisma-staging-config.repository";
import { StagingConfigValidationError } from "../domain/persisted-staging-config";

const PRISMA_DIR = path.join(__dirname, "../../../../prisma");
const dbFileName = `.p1b1-staging-${crypto.randomUUID()}.db`;
const dbPath = path.join(PRISMA_DIR, dbFileName);
const databaseUrl = `file:./${dbFileName}`;

describe("PrismaStagingConfigRepository (P1B1)", () => {
  let prisma: PrismaClient;
  let repository: PrismaStagingConfigRepository;
  let projectId: string;
  let otherProjectId: string;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousEncryptionKey = process.env.ENV_ENCRYPTION_KEY;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.ENV_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
    const prismaCli = require.resolve("prisma/build/index.js");
    execFileSync(process.execPath, [prismaCli, "db", "push", "--skip-generate"], {
      cwd: path.join(__dirname, "../../../.."),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    });
    prisma = new PrismaClient();
    await prisma.$connect();
    repository = new PrismaStagingConfigRepository(prisma as never, new EnvVarCipher());

    const project = await prisma.project.create({
      data: { name: "Projeto P1B1", repoUrl: "https://github.com/exemplo/p1b1.git" },
    });
    const other = await prisma.project.create({
      data: { name: "Outro projeto", repoUrl: "https://github.com/exemplo/outro.git" },
    });
    projectId = project.id;
    otherProjectId = other.id;
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-journal`, { force: true });
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousEncryptionKey === undefined) delete process.env.ENV_ENCRYPTION_KEY;
    else process.env.ENV_ENCRYPTION_KEY = previousEncryptionKey;
  });

  it("projeto sem configuração continua legado", async () => {
    await expect(repository.findByProjectId(projectId)).resolves.toBeNull();
  });

  it("persiste configuração válida, dependências e segredo cifrado sem expor valor", async () => {
    const saved = await repository.save(projectId, {
      mode: "isolated",
      ttlMinutes: 60,
      allowEgress: false,
      app: { memoryMb: 512, cpu: 0.5, diskMb: 1024 },
      dependencies: [
        {
          name: "database",
          kind: "postgres",
          envKey: "DATABASE_URL",
          resources: { memoryMb: 256, cpu: 0.25, diskMb: 512 },
        },
        {
          name: "billing",
          kind: "external",
          envKey: "BILLING_URL",
          target: { scheme: "https", host: "billing.staging.example", port: 443, database: null },
          externalSecretKey: "BILLING_SECRET",
        },
      ],
      secrets: [{ key: "BILLING_SECRET", value: "super-secret-value" }],
    });

    expect(saved.projectId).toBe(projectId);
    expect(saved.mode).toBe("isolated");
    expect(saved.app).toEqual({ memoryMb: 512, cpu: 0.5, diskMb: 1024 });
    expect(saved.dependencies).toHaveLength(2);
    expect(saved.dependencies.find((dep) => dep.name === "billing")?.externalSecretId).toBeTruthy();
    expect(saved.secrets).toEqual([
      expect.objectContaining({ key: "BILLING_SECRET" }),
    ]);
    expect(JSON.stringify(saved)).not.toContain("super-secret-value");

    const raw = await prisma.stagingSecret.findFirst({
      where: { projectId, key: "BILLING_SECRET" },
    });
    expect(raw?.valueCiphertext).toMatch(/^enc:v1:/);
    expect(raw?.valueCiphertext).not.toContain("super-secret-value");
    await expect(repository.resolveSecretValue(projectId, "BILLING_SECRET")).resolves.toBe(
      "super-secret-value",
    );
  });

  it("mantém configurações e dependências isoladas por projeto", async () => {
    await repository.save(otherProjectId, {
      mode: "isolated",
      ttlMinutes: 30,
      app: { memoryMb: 256, cpu: 0.25, diskMb: 512 },
      dependencies: [],
    });

    const first = await repository.findByProjectId(projectId);
    const second = await repository.findByProjectId(otherProjectId);
    expect(first?.projectId).toBe(projectId);
    expect(second?.projectId).toBe(otherProjectId);
    expect(second?.dependencies).toHaveLength(0);
    expect(first?.secrets.every((secret) => secret.key === "BILLING_SECRET")).toBe(true);
  });

  it("recusa configuração inválida sem gravar", async () => {
    await expect(
      repository.save(projectId, {
        mode: "isolated",
        ttlMinutes: 60,
        app: { memoryMb: 512, cpu: 0.5, diskMb: 1024 },
        dependencies: [
          {
            name: "billing",
            kind: "external",
            envKey: "BILLING_URL",
            target: { scheme: "https", host: "billing.example", port: 443, database: null },
            externalSecretKey: "MISSING_SECRET",
          },
        ],
      }),
    ).rejects.toBeInstanceOf(StagingConfigValidationError);

    const stillThere = await repository.findByProjectId(projectId);
    expect(stillThere?.secrets.map((secret) => secret.key)).toContain("BILLING_SECRET");
  });

  it("exclui configuração, dependências e segredos do projeto", async () => {
    await repository.deleteByProjectId(projectId);

    await expect(repository.findByProjectId(projectId)).resolves.toBeNull();
    await expect(
      prisma.stagingSecret.count({ where: { projectId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.stagingDependency.count({ where: { config: { projectId } } }),
    ).resolves.toBe(0);
  });

  it("propaga falha de leitura do banco", async () => {
    const failing = new PrismaStagingConfigRepository(
      {
        projectStagingConfig: {
          findUnique: jest.fn().mockRejectedValue(new Error("sqlite indisponível")),
        },
      } as never,
      new EnvVarCipher(),
    );

    await expect(failing.findByProjectId(projectId)).rejects.toThrow("sqlite indisponível");
  });

  it("propaga falha de escrita sem fallback", async () => {
    const failing = new PrismaStagingConfigRepository(
      {
        $transaction: jest.fn().mockRejectedValue(new Error("escrita bloqueada")),
      } as never,
      new EnvVarCipher(),
    );

    await expect(
      failing.save(projectId, {
        mode: "isolated",
        ttlMinutes: 60,
        app: { memoryMb: 512, cpu: 0.5, diskMb: 1024 },
        dependencies: [],
      }),
    ).rejects.toThrow("escrita bloqueada");
  });
});
