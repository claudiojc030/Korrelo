import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { EnvVarCipher } from "../../../infrastructure/crypto/env-var-cipher";
import {
  decryptManagedDatabaseCredentials,
  resolveDatabaseCredential,
} from "../../../infrastructure/crypto/resolve-database-credential";

/**
 * CREDENCIAL DO BANCO GERENCIADO NO BACKUP DIARIO.
 *
 * A senha do banco gerenciado fica CIFRADA em repouso no Core. O caminho
 * MANUAL (a API) passa pelo repositorio, que descriptografa; o caminho do
 * CRON (apps/api/scripts/backup.js) lia o Prisma direto e passava a senha
 * CIFRADA pro mongodump -> AuthenticationFailed/SCRAM-SHA-256.
 *
 * Estes testes travam a normalizacao unica (resolveDatabaseCredential) e
 * provam que o valor cifrado NUNCA chega ao mongodump.
 */

const requireCjs = createRequire(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../../../..");
const dumpLib = requireCjs(path.join(REPO_ROOT, "scripts", "backup-lib", "dump.cjs"));

const ENCRYPTION_KEY = "a".repeat(64);
const PLAINTEXT = "senha-real-do-mongo";
const FAKE_CIPHERTEXT_PREFIX = "enc:v1:";

describe("credencial do banco gerenciado no backup diario", () => {
  let previousKey: string | undefined;
  let cipher: EnvVarCipher;

  beforeEach(() => {
    previousKey = process.env.ENV_ENCRYPTION_KEY;
    process.env.ENV_ENCRYPTION_KEY = ENCRYPTION_KEY;
    cipher = new EnvVarCipher();
  });

  afterEach(() => {
    if (previousKey === undefined) delete process.env.ENV_ENCRYPTION_KEY;
    else process.env.ENV_ENCRYPTION_KEY = previousKey;
  });

  it("a senha gravada no Core e cifrada (enc:v1:...) e so o cipher descriptografa", () => {
    const stored = cipher.encrypt(PLAINTEXT);

    expect(stored.startsWith(FAKE_CIPHERTEXT_PREFIX)).toBe(true);
    expect(stored).not.toContain(PLAINTEXT);
    expect(resolveDatabaseCredential(stored, cipher)).toBe(PLAINTEXT);
  });

  it("o fluxo do cron descriptografa e a senha cifrada NUNCA chega ao mongodump", async () => {
    const stored = cipher.encrypt(PLAINTEXT);
    // O que o Prisma devolve no backup diario.
    const rowsFromPrisma = [
      {
        id: "p1",
        name: "Mesatta",
        managedDatabases: [
          { type: "mongodb", serviceName: "mongodb", username: "kor relo".replace(" ", ""), password: stored, databaseName: "mesatta" },
        ],
      },
    ];

    const projects = decryptManagedDatabaseCredentials(rowsFromPrisma as never, cipher);
    const resolved = (projects[0] as any).managedDatabases[0].password;

    expect(resolved).toBe(PLAINTEXT);
    expect(resolved).not.toContain(FAKE_CIPHERTEXT_PREFIX);

    // E o motor entrega isso ao binario SEM a senha no argv (so via env).
    const calls: Array<{ args: string[]; env: Record<string, string> | undefined }> = [];
    await dumpLib.dumpDatabase({
      dbType: "mongodb",
      containerName: "mesatta-mongodb-1",
      username: "kor relo".replace(" ", ""),
      password: resolved,
      outFile: path.join(os.tmpdir(), "korrelo-credencial-teste.archive"),
      backupRoot: os.tmpdir(),
      lockDir: path.join(os.tmpdir(), "korrelo-credencial-locks"),
      runProcess: async (options: any) => {
        calls.push({ args: options.args, env: options.env });
        if (options.stdoutPath) fs.writeFileSync(options.stdoutPath, "dados");
        return {
          code: 0, signal: null, stdout: "", stderr: "", bytesWritten: 4,
          timedOut: false, inactivityTimedOut: false, maxTimedOut: false,
          error: null, writeError: null, durationMs: 1,
        };
      },
    });

    expect(calls).toHaveLength(1);
    const args = calls[0].args.join(" ");
    // A senha cifrada NUNCA aparece - nem no argv, nem no env do child.
    expect(args).not.toContain(FAKE_CIPHERTEXT_PREFIX);
    expect(args).not.toContain(PLAINTEXT);
    expect(args).toContain("--password \"$KORRELO_MONGO_PASSWORD\"");
    // O valor em texto puro vai pelo ambiente (nao pelo argv).
    expect(calls[0].env?.KORRELO_MONGO_PASSWORD).toBe(PLAINTEXT);
    expect(calls[0].env?.KORRELO_MONGO_PASSWORD).not.toContain(FAKE_CIPHERTEXT_PREFIX);
  });

  it("senha legada (sem cifrar) continua funcionando", () => {
    expect(resolveDatabaseCredential("senha-legacy-em-texto", cipher)).toBe("senha-legacy-em-texto");
  });

  it("senha ausente nao quebra", () => {
    expect(resolveDatabaseCredential(null, cipher)).toBeNull();
    expect(resolveDatabaseCredential(undefined, cipher)).toBeNull();
    expect(resolveDatabaseCredential("", cipher)).toBeNull();
  });

  it("falha de descriptografia derruba o backup (falha fechada)", () => {
    const invalido = `${FAKE_CIPHERTEXT_PREFIX}00:11:22`;
    expect(() => resolveDatabaseCredential(invalido, cipher)).toThrow();
  });

  it("caminho manual e caminho do cron usam a MESMA normalizacao", () => {
    // O repositorio (caminho manual) chama resolveDatabaseCredential e o
    // script do cron chama decryptManagedDatabaseCredentials - as duas
    // funcoes vivem no mesmo modulo oficial.
    const stored = cipher.encrypt(PLAINTEXT);
    const viaRepository = resolveDatabaseCredential(stored, cipher);
    const viaCron = decryptManagedDatabaseCredentials(
      [{ managedDatabases: [{ password: stored }] }] as never,
      cipher,
    )[0].managedDatabases![0].password;

    expect(viaRepository).toBe(viaCron);
    expect(viaCron).toBe(PLAINTEXT);
  });
});
