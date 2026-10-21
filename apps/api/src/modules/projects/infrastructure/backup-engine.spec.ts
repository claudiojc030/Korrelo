import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadBackupLib } from "./backup-lib-loader";
import { readBackupManifest, readBackupState } from "./backup-manifest";

/**
 * SUÍTE DO MOTOR DE BACKUP/RESTORE (scripts/backup-lib).
 *
 * Cobre o que a auditoria apontou como P0/P1:
 * - dump do MongoDB por streaming (sem Buffer de 500MB na RAM);
 * - arquivo final só aparece depois do sucesso (temp + rename);
 * - falha (exit != 0, erro de escrita/ENOSPC, timeout) não publica nada;
 * - sha256 + manifesto;
 * - lock por banco (cron x manual);
 * - preflight de disco;
 * - permissões restritivas e senha fora do argv;
 * - restore só destrutivo DEPOIS de validar e de criar o backup de
 *   segurança do estado atual.
 */

const dumpLib = loadBackupLib<any>("dump.cjs");
const restoreLib = loadBackupLib<any>("restore.cjs");
const runnerLib = loadBackupLib<any>("process-runner.cjs");
const fileLib = loadBackupLib<any>("backup-file.cjs");
const retentionLib = loadBackupLib<any>("retention.cjs");
const projectBackupLib = loadBackupLib<any>("project-backup.cjs");

interface FakeCall {
  command: string;
  args: string[];
  stdoutPath?: string;
  stdinPath?: string;
  options: Record<string, unknown>;
}

interface FakeResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  bytesWritten: number;
  timedOut: boolean;
  inactivityTimedOut: boolean;
  maxTimedOut: boolean;
  error: Error | null;
  writeError: (Error & { code?: string }) | null;
  durationMs: number;
}

function baseResult(overrides: Partial<FakeResult> = {}): FakeResult {
  return {
    code: 0,
    signal: null,
    stdout: "",
    stderr: "",
    bytesWritten: 0,
    timedOut: false,
    inactivityTimedOut: false,
    maxTimedOut: false,
    error: null,
    writeError: null,
    durationMs: 5,
    ...overrides,
  };
}

describe("motor de backup/restore", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-backup-engine-"));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  /** Runner falso: simula o dump escrevendo no arquivo em vários chunks. */
  function fakeRunner(options: {
    payload?: Buffer;
    code?: number;
    stderr?: string;
    writeError?: (Error & { code?: string }) | null;
    onCall?: (call: FakeCall) => void;
    calls?: FakeCall[];
  }) {
    const payload = options.payload ?? Buffer.from("conteudo-do-dump");
    const calls = options.calls ?? [];

    return async (runOptions: any): Promise<FakeResult> => {
      const call: FakeCall = {
        command: runOptions.command,
        args: runOptions.args ?? [],
        stdoutPath: runOptions.stdoutPath,
        stdinPath: runOptions.stdinPath,
        options: runOptions,
      };
      calls.push(call);
      options.onCall?.(call);

      if (runOptions.stdoutPath) {
        const chunkSize = 16 * 1024;
        for (let offset = 0; offset < payload.length; offset += chunkSize) {
          const chunk = payload.subarray(offset, Math.min(offset + chunkSize, payload.length));
          fs.appendFileSync(runOptions.stdoutPath, chunk);
          runOptions.onProgress?.(Math.min(offset + chunkSize, payload.length));
        }
      }

      if (options.writeError) {
        return baseResult({ code: null, writeError: options.writeError, bytesWritten: 0 });
      }

      return baseResult({
        code: options.code ?? 0,
        stderr: options.stderr ?? "",
        bytesWritten: runOptions.stdoutPath ? payload.length : 0,
      });
    };
  }

  describe("dump do MongoDB", () => {
    it("faz o dump por streaming (sem Buffer na RAM, sem maxBuffer)", async () => {
      const outFile = path.join(workDir, "proj-mongodb.archive");
      const payload = Buffer.alloc(3 * 1024 * 1024, "m");
      const calls: FakeCall[] = [];

      const result = await dumpLib.dumpDatabase({
        dbType: "mongodb",
        containerName: "app-mongo-1",
        username: "user",
        password: "senha-secreta",
        outFile,
        reason: "cron",
        runProcess: fakeRunner({ payload, calls }),
        lockDir: path.join(workDir, "locks"),
      });

      expect(result.ok).toBe(true);
      expect(fs.existsSync(outFile)).toBe(true);
      expect(fs.statSync(outFile).size).toBe(payload.length);

      // O stdout do dump foi para o ARQUIVO (stream), não pra memória.
      expect(calls).toHaveLength(1);
      expect(calls[0].stdoutPath).toBeTruthy();
      expect(calls[0].options.maxBuffer).toBeUndefined();
      expect(calls[0].options.encoding).toBeUndefined();
    });

    it("não deixa a senha no argv do comando", async () => {
      const spec = dumpLib.buildMongoDumpCommand({
        containerName: "app-mongo-1",
        username: "korrelouser",
        password: "senha-secreta",
      });

      expect(spec.args.join(" ")).not.toContain("senha-secreta");
      expect(spec.args.join(" ")).not.toContain("korrelouser");
      expect(spec.env.KORRELO_MONGO_PASSWORD).toBe("senha-secreta");
      expect(spec.env.KORRELO_MONGO_USER).toBe("korrelouser");
    });

    it("não publica o arquivo final antes do dump terminar", async () => {
      const outFile = path.join(workDir, "proj-mongodb.archive");
      let existedDuringRun = true;

      await dumpLib.dumpDatabase({
        dbType: "mongodb",
        containerName: "app-mongo-1",
        outFile,
        runProcess: fakeRunner({
          onCall: () => {
            existedDuringRun = fs.existsSync(outFile);
          },
        }),
        lockDir: path.join(workDir, "locks"),
      });

      expect(existedDuringRun).toBe(false);
      expect(fs.existsSync(outFile)).toBe(true);
      // O temporário some depois do rename.
      expect(fs.readdirSync(workDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
    });

    it("não publica nada quando o comando termina com erro", async () => {
      const outFile = path.join(workDir, "proj-mongodb.archive");

      const result = await dumpLib.dumpDatabase({
        dbType: "mongodb",
        containerName: "app-mongo-1",
        outFile,
        runProcess: fakeRunner({ code: 1, stderr: "connection refused" }),
        lockDir: path.join(workDir, "locks"),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("connection refused");
      expect(fs.existsSync(outFile)).toBe(false);
      expect(fs.readdirSync(workDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
    });

    it("trata erro de escrita (ENOSPC) como falha e limpa o temporário", async () => {
      const outFile = path.join(workDir, "proj-mongodb.archive");
      const enospc = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });

      const result = await dumpLib.dumpDatabase({
        dbType: "mongodb",
        containerName: "app-mongo-1",
        outFile,
        runProcess: fakeRunner({ writeError: enospc }),
        lockDir: path.join(workDir, "locks"),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("ENOSPC");
      expect(fs.existsSync(outFile)).toBe(false);
      expect(fs.readdirSync(workDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
    });

    it("grava sha256 e manifesto ao lado do arquivo, sem segredo", async () => {
      const outFile = path.join(workDir, "proj-mongodb.archive");
      const payload = Buffer.from("conteudo-do-dump");

      const result = await dumpLib.dumpDatabase({
        dbType: "mongodb",
        containerName: "app-mongo-1",
        username: "user",
        password: "senha-secreta",
        outFile,
        reason: "cron",
        projectId: "proj-1",
        serviceName: "mongodb",
        runProcess: fakeRunner({ payload }),
        lockDir: path.join(workDir, "locks"),
      });

      expect(result.ok).toBe(true);
      expect(result.sha256).toEqual(expect.any(String));

      const manifestPath = fileLib.buildManifestPath(outFile);
      expect(fs.existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      expect(manifest.status).toBe("complete");
      expect(manifest.version).toBe(1);
      expect(manifest.projectId).toBe("proj-1");
      expect(manifest.dbType).toBe("mongodb");
      expect(manifest.bytes).toBe(payload.length);
      expect(manifest.sha256).toBe(result.sha256);
      expect(manifest.format).toBe("mongodump-archive");
      expect(manifest.reason).toBe("cron");
      // Nenhum segredo no manifesto.
      expect(JSON.stringify(manifest)).not.toContain("senha-secreta");
    });

    it("aplica permissão restritiva no arquivo", async () => {
      const outFile = path.join(workDir, "proj-mongodb.archive");

      await dumpLib.dumpDatabase({
        dbType: "mongodb",
        containerName: "app-mongo-1",
        outFile,
        runProcess: fakeRunner({}),
        lockDir: path.join(workDir, "locks"),
      });

      if (process.platform !== "win32") {
        expect(fs.statSync(outFile).mode & 0o777).toBe(0o600);
        expect(fs.statSync(fileLib.buildManifestPath(outFile)).mode & 0o777).toBe(0o600);
      }
    });
  });

  describe("lock por banco", () => {
    it("bloqueia dois backups do mesmo banco", async () => {
      const first = path.join(workDir, "a.archive");
      const second = path.join(workDir, "b.archive");
      const lockDir = path.join(workDir, "locks");
      const calls: FakeCall[] = [];

      const running = dumpLib.dumpDatabase({
        dbType: "mongodb",
        containerName: "app-mongo-1",
        outFile: first,
        runProcess: async (runOptions: any) => {
          // enquanto o primeiro dump roda, o lock está taken.
          const blocked = await dumpLib.dumpDatabase({
            dbType: "mongodb",
            containerName: "app-mongo-1",
            outFile: second,
            runProcess: fakeRunner({ calls }),
            lockDir,
          });
          expect(blocked.ok).toBe(false);
          expect(blocked.error).toContain("já existe um backup em andamento");
          return fakeRunner({ calls })(runOptions);
        },
        lockDir,
      });

      const result = await running;
      expect(result.ok).toBe(true);
      expect(fs.existsSync(second)).toBe(false);
    });

    it("não colide entre bancos diferentes", async () => {
      const calls: FakeCall[] = [];
      const first = dumpLib.dumpDatabase({
        dbType: "mongodb",
        containerName: "app-mongo-1",
        outFile: path.join(workDir, "a.archive"),
        runProcess: fakeRunner({ calls }),
        lockDir: path.join(workDir, "locks"),
      });
      const second = dumpLib.dumpDatabase({
        dbType: "postgres",
        containerName: "app-postgres-1",
        outFile: path.join(workDir, "b.sql"),
        runProcess: fakeRunner({ calls }),
        lockDir: path.join(workDir, "locks"),
      });

      const [a, b] = await Promise.all([first, second]);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
    });

    it("libera o lock depois de uma falha", async () => {
      const lockDir = path.join(workDir, "locks");
      const failed = await dumpLib.dumpDatabase({
        dbType: "mongodb",
        containerName: "app-mongo-1",
        outFile: path.join(workDir, "a.archive"),
        runProcess: fakeRunner({ code: 1 }),
        lockDir,
      });
      expect(failed.ok).toBe(false);

      const second = await dumpLib.dumpDatabase({
        dbType: "mongodb",
        containerName: "app-mongo-1",
        outFile: path.join(workDir, "b.archive"),
        runProcess: fakeRunner({}),
        lockDir,
      });
      expect(second.ok).toBe(true);
    });
  });

  describe("dump do Postgres", () => {
    it("preserva o formato (SQL puro) e faz temp/rename", async () => {
      const outFile = path.join(workDir, "proj-postgres.sql");
      const sql = "CREATE TABLE users (id int);\nINSERT INTO users VALUES (1);\n";

      const result = await dumpLib.dumpDatabase({
        dbType: "postgres",
        containerName: "app-postgres-1",
        username: "postgres",
        password: "senha",
        databaseName: "app",
        outFile,
        runProcess: fakeRunner({ payload: Buffer.from(sql) }),
        lockDir: path.join(workDir, "locks"),
      });

      expect(result.ok).toBe(true);
      expect(fs.readFileSync(outFile, "utf-8")).toBe(sql);
      expect(fs.readdirSync(workDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
    });

    it("não publica nada quando o pg_dump falha", async () => {
      const outFile = path.join(workDir, "proj-postgres.sql");

      const result = await dumpLib.dumpDatabase({
        dbType: "postgres",
        containerName: "app-postgres-1",
        outFile,
        runProcess: fakeRunner({ code: 1, stderr: "pg_dump: erro" }),
        lockDir: path.join(workDir, "locks"),
      });

      expect(result.ok).toBe(false);
      expect(fs.existsSync(outFile)).toBe(false);
    });

    it("não deixa a senha do Postgres no argv do core", () => {
      const spec = dumpLib.buildCorePostgresDumpCommand({
        databaseUrl: "postgres://user:senha123@localhost:5432/korrelo",
      });
      expect(spec.args.join(" ")).not.toContain("senha123");
      expect(spec.env.PGPASSWORD).toBe("senha123");
      expect(spec.env.PGHOST).toBe("localhost");
      expect(spec.env.PGDATABASE).toBe("korrelo");
    });
  });

  describe("uploads", () => {
    it("copia por docker cp (sem passar o volume pela RAM) e não engole erro", async () => {
      const calls: FakeCall[] = [];
      const outDir = path.join(workDir, "proj-uploads");

      const result = await dumpLib.dumpUploads({
        containerName: "app-1",
        outDir,
        runProcess: fakeRunner({
          code: 1,
          stderr: "Error response from daemon: write error: no space left on device",
          calls,
        }),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("no space left on device");
      // docker cp escreve direto no destino - não há stdout a ser capturado.
      expect(calls[0].args[0]).toBe("cp");
      expect(calls[0].stdoutPath).toBeUndefined();
      expect(calls[0].options.maxBuffer).toBeUndefined();
    });

    it("trata '/app/uploads inexistente' como skip, não como falha", async () => {
      const outDir = path.join(workDir, "proj-uploads");

      const result = await dumpLib.dumpUploads({
        containerName: "app-1",
        outDir,
        runProcess: fakeRunner({
          code: 1,
          stderr: "Error response from daemon: Could not find the file /app/uploads in container app-1",
        }),
      });

      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(true);
    });
  });

  describe("execuração do processo", () => {
    it("limita o stderr guardado em memória", async () => {
      const result = await runnerLib.runProcess({
        command: process.execPath,
        args: ["-e", "process.stderr.write('E'.repeat(200000)); process.exit(3);"],
        stderrLimit: 2048,
      });

      expect(result.code).toBe(3);
      expect(result.stderr.length).toBeLessThanOrEqual(2048);
    });

    it("mata o processo que para de produzir (timeout por inatividade)", async () => {
      const result = await runnerLib.runProcess({
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 60000)"],
        stdoutPath: path.join(workDir, "idle.bin"),
        inactivityTimeoutMs: 1000,
        killGraceMs: 200,
      });

      expect(result.inactivityTimedOut).toBe(true);
      expect(result.timedOut).toBe(true);
    });

    it("não considera timeout um dump grande que continua escrevendo", async () => {
      const outFile = path.join(workDir, "grande.bin");
      // 20 chunks de 100ms = 2s de dump ativo, acima do timeout de
      // inatividade de 1,5s: um dump grande NÃO pode ser morto.
      const result = await runnerLib.runProcess({
        command: process.execPath,
        args: [
          "-e",
          "const c = Buffer.alloc(256 * 1024, 'x'); let i = 0; const t = setInterval(() => { process.stdout.write(c); if (++i > 20) { clearInterval(t); } }, 100);",
        ],
        stdoutPath: outFile,
        inactivityTimeoutMs: 1500,
        killGraceMs: 200,
      });

      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(0);
      expect(fs.statSync(outFile).size).toBeGreaterThan(0);
    });

    it("reporta erro de escrita no arquivo de destino", async () => {
      const result = await runnerLib.runProcess({
        command: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(1000))"],
        stdoutPath: path.join(workDir, "nao-existe", "sub", "arquivo.bin"),
      });

      expect(result.writeError).toBeTruthy();
      expect(result.code).not.toBe(0);
    });
  });

  describe("restore seguro", () => {
    async function makeBackup(name = "proj-mongodb.archive"): Promise<string> {
      const outFile = path.join(workDir, name);
      await dumpLib.dumpDatabase({
        dbType: "mongodb",
        containerName: "app-mongo-1",
        username: "user",
        password: "senha",
        outFile,
        runProcess: fakeRunner({ payload: Buffer.from("conteudo-do-dump") }),
        lockDir: path.join(workDir, "locks"),
      });
      return outFile;
    }

    it("recusa arquivo truncado ANTES de rodar o mongorestore --drop", async () => {
      const outFile = await makeBackup();
      // Manifesto com tamanho diferente do arquivo = truncado.
      const manifestPath = fileLib.buildManifestPath(outFile);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      manifest.bytes = 999999;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));

      const calls: FakeCall[] = [];
      const result = await restoreLib.restoreDatabase({
        dbType: "mongodb",
        containerName: "app-mongo-1",
        inFile: outFile,
        preRestoreDir: path.join(workDir, "pre-restore"),
        runProcess: fakeRunner({ calls }),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("não bate com o manifesto");
      // Nenhum comando de restore foi executado.
      expect(calls.filter((call) => call.args.join(" ").includes("mongorestore"))).toHaveLength(0);
    });

    it("recusa checksum divergente", async () => {
      const outFile = await makeBackup();
      const manifestPath = fileLib.buildManifestPath(outFile);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      manifest.sha256 = "0".repeat(64);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));

      const calls: FakeCall[] = [];
      const result = await restoreLib.restoreDatabase({
        dbType: "mongodb",
        containerName: "app-mongo-1",
        inFile: outFile,
        preRestoreDir: path.join(workDir, "pre-restore"),
        runProcess: fakeRunner({ calls }),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("checksum");
      expect(calls.filter((call) => call.args.join(" ").includes("mongorestore"))).toHaveLength(0);
    });

    it("recusa arquivo temporário (dump em andamento)", async () => {
      const tmpFile = path.join(workDir, "proj-mongodb.archive.tmp-abc123");
      fs.writeFileSync(tmpFile, "parcial");

      const result = await restoreLib.restoreDatabase({
        dbType: "mongodb",
        containerName: "app-mongo-1",
        inFile: tmpFile,
        runProcess: fakeRunner({}),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("ainda está sendo escrito");
    });

    it("cria o backup de segurança ANTES do restore destrutivo", async () => {
      const outFile = await makeBackup();
      const order: string[] = [];
      const calls: FakeCall[] = [];

      const result = await restoreLib.restoreDatabase({
        dbType: "mongodb",
        containerName: "app-mongo-1",
        username: "user",
        password: "senha",
        inFile: outFile,
        preRestoreDir: path.join(workDir, "pre-restore"),
        runProcess: async (runOptions: any) => {
          calls.push({
            command: runOptions.command,
            args: runOptions.args ?? [],
            stdoutPath: runOptions.stdoutPath,
            stdinPath: runOptions.stdinPath,
            options: runOptions,
          });
          order.push((runOptions.args ?? []).join(" ").includes("mongorestore") ? "restore" : "dump");
          return baseResult({ bytesWritten: 0 });
        },
        dumpFn: async (dumpOptions: any) => {
          order.push("pre-restore");
          return { ok: true, outFile: dumpOptions.outFile, bytes: 10, sha256: "abc", manifest: null };
        },
      });

      expect(result.ok).toBe(true);
      expect(order[0]).toBe("pre-restore");
      expect(order[order.length - 1]).toBe("restore");
      expect(result.preRestoreBackupPath).toBeTruthy();
    });

    it("aborta o restore quando o backup de segurança falha", async () => {
      const outFile = await makeBackup();
      const calls: FakeCall[] = [];

      const result = await restoreLib.restoreDatabase({
        dbType: "mongodb",
        containerName: "app-mongo-1",
        inFile: outFile,
        preRestoreDir: path.join(workDir, "pre-restore"),
        runProcess: fakeRunner({ calls }),
        dumpFn: async () => ({ ok: false, error: "sem espaço", outFile: null, bytes: 0, sha256: null, manifest: null }),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("restore abortado");
      expect(calls.filter((call) => call.args.join(" ").includes("mongorestore"))).toHaveLength(0);
    });

    it("mantém o mongorestore --drop compatível com o .archive", async () => {
      const outFile = await makeBackup();
      const calls: FakeCall[] = [];

      await restoreLib.restoreDatabase({
        dbType: "mongodb",
        containerName: "app-mongo-1",
        username: "user",
        password: "senha",
        inFile: outFile,
        preRestoreDir: path.join(workDir, "pre-restore"),
        runProcess: fakeRunner({ calls }),
        dumpFn: async (dumpOptions: any) => ({
          ok: true,
          outFile: dumpOptions.outFile,
          bytes: 10,
          sha256: "abc",
          manifest: null,
        }),
      });

      const restoreCall = calls.find((call) => call.args.join(" ").includes("mongorestore"));
      expect(restoreCall).toBeTruthy();
      expect(restoreCall!.args.join(" ")).toContain("--archive");
      expect(restoreCall!.args.join(" ")).toContain("--drop");
      expect(restoreCall!.stdinPath).toBe(outFile);
      // A senha não vai no argv.
      expect(restoreCall!.args.join(" ")).not.toContain("senha");
    });

    it("mantém o restore do Postgres compatível com o .sql", async () => {
      const outFile = path.join(workDir, "proj-postgres.sql");
      await dumpLib.dumpDatabase({
        dbType: "postgres",
        containerName: "app-postgres-1",
        username: "postgres",
        password: "senha",
        databaseName: "app",
        outFile,
        runProcess: fakeRunner({ payload: Buffer.from("CREATE TABLE t (id int);") }),
        lockDir: path.join(workDir, "locks"),
      });

      const calls: FakeCall[] = [];
      await restoreLib.restoreDatabase({
        dbType: "postgres",
        containerName: "app-postgres-1",
        username: "postgres",
        password: "senha",
        databaseName: "app",
        inFile: outFile,
        preRestoreDir: path.join(workDir, "pre-restore"),
        runProcess: fakeRunner({ calls }),
        dumpFn: async (dumpOptions: any) => ({
          ok: true,
          outFile: dumpOptions.outFile,
          bytes: 10,
          sha256: "abc",
          manifest: null,
        }),
      });

      const psqlCalls = calls.filter((call) => call.args.includes("psql"));
      expect(psqlCalls.length).toBeGreaterThanOrEqual(2);
      expect(psqlCalls[0].args.join(" ")).toContain("DROP SCHEMA public CASCADE");
      expect(psqlCalls[1].stdinPath).toBe(outFile);
    });

    it("aceita backup legado (sem manifesto) com aviso", async () => {
      const outFile = path.join(workDir, "legado.archive");
      fs.writeFileSync(outFile, "conteudo-antigo");

      const calls: FakeCall[] = [];
      const logs: string[] = [];
      const result = await restoreLib.restoreDatabase({
        dbType: "mongodb",
        containerName: "app-mongo-1",
        inFile: outFile,
        preRestoreDir: path.join(workDir, "pre-restore"),
        runProcess: fakeRunner({ calls }),
        dumpFn: async (dumpOptions: any) => ({
          ok: true,
          outFile: dumpOptions.outFile,
          bytes: 10,
          sha256: "abc",
          manifest: null,
        }),
        onLog: (message: string) => logs.push(message),
      });

      expect(result.ok).toBe(true);
      expect(logs.join("\n")).toContain("legado");
    });
  });

  describe("dump do Redis", () => {
    it("salva o RDB e publica por rename (sem Buffer)", async () => {
      const outFile = path.join(workDir, "proj-redis.rdb");
      const calls: FakeCall[] = [];

      const result = await dumpLib.dumpDatabase({
        dbType: "redis",
        containerName: "app-redis-1",
        password: "senha",
        outFile,
        runProcess: async (runOptions: any) => {
          calls.push({
            command: runOptions.command,
            args: runOptions.args ?? [],
            stdoutPath: runOptions.stdoutPath,
            stdinPath: runOptions.stdinPath,
            options: runOptions,
          });
          // O `docker cp` escreve direto no arquivo de destino (não passa
          // por stdout): o runner falso simula isso.
          if ((runOptions.args ?? []).includes("cp")) {
            const target = runOptions.args[runOptions.args.length - 1];
            fs.writeFileSync(target, "RDB-FALSO");
          }
          return baseResult({ bytesWritten: 0 });
        },
        lockDir: path.join(workDir, "locks"),
      });

      expect(result.ok).toBe(true);
      expect(fs.existsSync(outFile)).toBe(true);
      expect(fs.readFileSync(outFile, "utf-8")).toBe("RDB-FALSO");
      // SAVE antes do cp.
      expect(calls.length).toBe(2);
      expect(calls[0].args.join(" ")).toContain("redis-cli");
      expect(calls[1].args[0]).toBe("cp");
      // A senha do Redis não vai no argv.
      expect(calls[0].args.join(" ")).not.toContain("senha");
    });

    it("não publica nada quando o SAVE do Redis falha", async () => {
      const outFile = path.join(workDir, "proj-redis.rdb");

      const result = await dumpLib.dumpDatabase({
        dbType: "redis",
        containerName: "app-redis-1",
        outFile,
        runProcess: fakeRunner({ code: 1, stderr: "NOAUTH" }),
        lockDir: path.join(workDir, "locks"),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("NOAUTH");
      expect(fs.existsSync(outFile)).toBe(false);
    });
  });

  describe("backup do Core (SQLite/Postgres)", () => {
    it("SQLite: usa o .backup do sqlite3 e publica com manifesto", async () => {
      const dbFile = path.join(workDir, "dev.db");
      fs.writeFileSync(dbFile, "conteudo-do-banco");
      const outFile = path.join(workDir, "core.db");
      const calls: FakeCall[] = [];

      const result = await dumpLib.dumpCoreDatabase({
        databaseUrl: "file:./dev.db",
        sqliteFile: dbFile,
        outFile,
        runProcess: async (runOptions: any) => {
          calls.push({
            command: runOptions.command,
            args: runOptions.args ?? [],
            stdoutPath: runOptions.stdoutPath,
            stdinPath: runOptions.stdinPath,
            options: runOptions,
          });
          // O sqlite3 escreve o arquivo de backup no disco (1a chamada é o
          // `.backup`, a 2a é o PRAGMA integrity_check).
          const backupArg = (runOptions.args ?? []).find((arg: string) => arg.includes(".backup"));
          if (backupArg) {
            const tempPath = backupArg.match(/'(.+)'/)?.[1];
            if (tempPath) fs.writeFileSync(tempPath, "backup-sqlite");
          }
          if ((runOptions.args ?? []).includes("PRAGMA integrity_check;")) {
            return baseResult({ stdout: "ok\n" });
          }
          return baseResult();
        },
      });

      expect(result.ok).toBe(true);
      expect(fs.existsSync(outFile)).toBe(true);
      expect(calls.length).toBe(2);
      expect(calls[1].args.join(" ")).toContain("PRAGMA integrity_check");
      const manifest = JSON.parse(fs.readFileSync(fileLib.buildManifestPath(outFile), "utf-8"));
      expect(manifest.status).toBe("complete");
      expect(manifest.format).toBe("sqlite-backup");
    });

    it("SQLite: reprova o backup que falha no integrity_check", async () => {
      const dbFile = path.join(workDir, "dev.db");
      fs.writeFileSync(dbFile, "conteudo-do-banco");
      const outFile = path.join(workDir, "core.db");

      const result = await dumpLib.dumpCoreDatabase({
        databaseUrl: "file:./dev.db",
        sqliteFile: dbFile,
        outFile,
        runProcess: async (runOptions: any) => {
          const backupArg = (runOptions.args ?? []).find((arg: string) => arg.includes(".backup"));
          if (backupArg) {
            const tempPath = backupArg.match(/'(.+)'/)?.[1];
            if (tempPath) fs.writeFileSync(tempPath, "backup-sqlite");
          }
          if ((runOptions.args ?? []).includes("PRAGMA integrity_check;")) {
            return baseResult({ stdout: "database disk image is malformed\n" });
          }
          return baseResult();
        },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("integrity_check");
      expect(fs.existsSync(outFile)).toBe(false);
    });

    it("SQLite: sem o binário sqlite3, cai na cópia direta (comportamento de sempre)", async () => {
      const dbFile = path.join(workDir, "dev.db");
      fs.writeFileSync(dbFile, "conteudo-do-banco");
      const outFile = path.join(workDir, "core.db");

      const result = await dumpLib.dumpCoreDatabase({
        databaseUrl: "file:./dev.db",
        sqliteFile: dbFile,
        outFile,
        runProcess: fakeRunner({ code: 1, stderr: "sqlite3: not found" }),
      });

      expect(result.ok).toBe(true);
      expect(fs.readFileSync(outFile, "utf-8")).toBe("conteudo-do-banco");
    });

    it("Postgres do Core: dump em streaming com a senha fora do argv", async () => {
      const outFile = path.join(workDir, "core.sql");
      const calls: FakeCall[] = [];

      const result = await dumpLib.dumpCoreDatabase({
        databaseUrl: "postgres://user:senha-core@localhost:5432/korrelo",
        outFile,
        runProcess: fakeRunner({ payload: Buffer.from("SELECT 1;\n"), calls }),
      });

      expect(result.ok).toBe(true);
      expect(fs.readFileSync(outFile, "utf-8")).toBe("SELECT 1;\n");
      expect(calls[0].args.join(" ")).not.toContain("senha-core");
      expect((calls[0].options.env as Record<string, string>).PGPASSWORD).toBe("senha-core");
    });
  });

  describe("compatibilidade entre o manifesto do motor (CJS) e a leitura da API (TS)", () => {
    it("a API lê o manifesto escrito pelo motor", async () => {
      const outFile = path.join(workDir, "proj-mongodb.archive");
      await dumpLib.dumpDatabase({
        dbType: "mongodb",
        containerName: "app-mongo-1",
        username: "user",
        password: "senha",
        outFile,
        reason: "cron",
        projectId: "proj-9",
        serviceName: "mongodb",
        runProcess: fakeRunner({ payload: Buffer.from("conteudo") }),
        lockDir: path.join(workDir, "locks"),
      });

      const manifest = await readBackupManifest(outFile);
      expect(manifest).not.toBeNull();
      expect(manifest!.status).toBe("complete");
      expect(manifest!.projectId).toBe("proj-9");
      expect(manifest!.dbType).toBe("mongodb");
      expect(manifest!.reason).toBe("cron");

      const state = await readBackupState(outFile);
      expect(state.state).toBe("complete");
      expect(state.validated).toBe(true);

      // O manifesto bate com o conteúdo real do arquivo (nenhum checksum
      // órfão de outro dump).
      const actualSha = await fileLib.sha256File(outFile);
      expect(manifest!.sha256).toBe(actualSha);
      expect(manifest!.bytes).toBe(fs.statSync(outFile).size);
    });
  });

  describe("retenção", () => {    it("mantém o backup mais recente e não apaga dump em andamento", async () => {
      const root = path.join(workDir, "backups");
      const old = path.join(root, "2020-01-01T00-00-00-000Z");
      const recent = path.join(root, "2026-01-01T00-00-00-000Z");
      const active = path.join(root, "2026-01-02T00-00-00-000Z");
      fs.mkdirSync(old, { recursive: true });
      fs.mkdirSync(recent, { recursive: true });
      fs.mkdirSync(active, { recursive: true });
      fs.writeFileSync(path.join(old, "x.archive"), "velho");
      fs.writeFileSync(path.join(recent, "x.archive"), "novo");
      fs.writeFileSync(path.join(active, "x.archive.tmp-job1"), "em andamento");

      const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      fs.utimesSync(old, ancient, ancient);
      fs.utimesSync(active, ancient, ancient);
      fs.utimesSync(recent, new Date(), new Date());

      const result = await retentionLib.pruneOldBackups({ root, retentionDays: 7 });

      expect(result.removed).toContain(old);
      expect(result.removed).not.toContain(recent);
      expect(result.removed).not.toContain(active);
      expect(fs.existsSync(active)).toBe(true);
    });
  });

  describe("backup dos bancos dos projetos", () => {
    it("coloca a falha no array de failures sem engolir erro", async () => {
      const projects = [
        {
          id: "p1",
          name: "Projeto Um",
          containerName: "proj-um",
          managedDatabases: [
            { type: "mongodb", serviceName: "mongodb", username: "u", password: "p", databaseName: "db" },
            { type: "postgres", serviceName: "postgres", username: "u", password: "p", databaseName: "db" },
          ],
        },
      ];

      const { failures, results } = await projectBackupLib.backupProjects(projects, {
        destDir: workDir,
        backupRoot: workDir,
        reason: "cron",
        includeUploads: false,
        runProcess: fakeRunner({ code: 1, stderr: "dump quebrado" }),
      });

      expect(failures.length).toBe(2);
      expect(failures[0]).toContain("Projeto Um (mongodb)");
      expect(failures[1]).toContain("Projeto Um (postgres)");
      expect(results.every((result: any) => result.ok === false)).toBe(true);
    });
  });
});
