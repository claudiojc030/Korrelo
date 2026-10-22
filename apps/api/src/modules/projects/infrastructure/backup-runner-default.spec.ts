import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

/**
 * REGRESSÃO DO DEFAULT DO RUNNER (P0).
 *
 * O motor desestruturava a opção do runner assim:
 *
 *   const { ..., runProcess = runProcess, ... } = options || {};
 *
 * O valor padrão é avaliado no escopo do PRÓPRIO binding desestruturado,
 * que ainda está em TDZ. Quem chamava o motor sem injetar `runProcess`
 * (cron, dump-cli, restore-cli, botão "Fazer backup agora") recebia:
 *
 *   ReferenceError: Cannot access 'runProcess' before initialization
 *
 * Este arquivo trava a correção: os testes chamam o motor EXATAMENTE como
 * a produção (SEM `runProcess`) e exigem que o default real seja
 * resolvido - se alguém reintroduzir `runProcess = runProcess`, estes
 * testes falham.
 */

const requireCjs = createRequire(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../../../..");
const LIB_DIR = path.join(REPO_ROOT, "scripts", "backup-lib");

const dumpLib = requireCjs(path.join(LIB_DIR, "dump.cjs"));
const restoreLib = requireCjs(path.join(LIB_DIR, "restore.cjs"));
const projectBackupLib = requireCjs(path.join(LIB_DIR, "project-backup.cjs"));

/** Padrão que indicaria a reintrodução do bug. */
const TDZ_PATTERN = /before initialization|Cannot access/;

function fakeResult(overrides: Record<string, unknown> = {}) {
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
    durationMs: 1,
    ...overrides,
  };
}

describe("default do runner do motor de backup (P0)", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-runner-default-"));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("dumpDatabase SEM runProcess (forma de produção) resolve o default real", async () => {
    const result = await dumpLib.dumpDatabase({
      dbType: "mongodb",
      containerName: "app-mongo-1",
      username: "",
      password: "",
      outFile: path.join(workDir, "saida.archive"),
      backupRoot: workDir,
      lockDir: path.join(workDir, "locks"),
    });

    // Sem docker/mongodump local o dump falha na EXECUÇÃO - o que prova
    // que a inicialização passou e o runner real foi resolvido.
    expect(String(result.error || "")).not.toMatch(TDZ_PATTERN);
    expect(result.ok).toBe(false);
  });

  it("dumpUploads SEM runProcess resolve o default real", async () => {
    const result = await dumpLib.dumpUploads({
      containerName: "app-1",
      outDir: path.join(workDir, "uploads"),
    });

    expect(String(result.error || "")).not.toMatch(TDZ_PATTERN);
  });

  it("dumpCoreDatabase SEM runProcess resolve o default real", async () => {
    const dbFile = path.join(workDir, "dev.db");
    fs.writeFileSync(dbFile, "conteudo");

    const result = await dumpLib.dumpCoreDatabase({
      databaseUrl: "file:./dev.db",
      sqliteFile: dbFile,
      outFile: path.join(workDir, "core.db"),
    });

    expect(String(result.error || "")).not.toMatch(TDZ_PATTERN);
  });

  it("restoreDatabase SEM runProcess resolve o default real", async () => {
    const inFile = path.join(workDir, "entrada.archive");
    fs.writeFileSync(inFile, "conteudo");

    const result = await restoreLib.restoreDatabase({
      dbType: "mongodb",
      containerName: "app-mongo-1",
      username: "",
      password: "",
      inFile,
      preRestoreDir: path.join(workDir, "pre-restore"),
      lockDir: path.join(workDir, "locks"),
    });

    expect(String(result.error || "")).not.toMatch(TDZ_PATTERN);
  });

  it("backupProjects (caminho do cron) SEM runProcess não dá ReferenceError", async () => {
    const projects = [
      {
        id: "p1",
        name: "Projeto Um",
        containerName: "proj-um",
        managedDatabases: [
          { type: "mongodb", serviceName: "mongodb", username: "u", password: "p", databaseName: "db" },
        ],
      },
    ];

    const { failures } = await projectBackupLib.backupProjects(projects, {
      destDir: workDir,
      backupRoot: workDir,
      reason: "cron",
      includeUploads: false,
    });

    // Deve falhar por falta de docker/mongodump, nunca por TDZ.
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join("\n")).not.toMatch(TDZ_PATTERN);
  });

  it("com runProcess customizado, o customizado é o usado", async () => {
    let chamadas = 0;
    const custom = async () => {
      chamadas += 1;
      return fakeResult();
    };

    const result = await dumpLib.dumpDatabase({
      dbType: "mongodb",
      containerName: "app-mongo-1",
      username: "",
      password: "",
      outFile: path.join(workDir, "saida.archive"),
      backupRoot: workDir,
      lockDir: path.join(workDir, "locks"),
      runProcess: custom,
    });

    expect(chamadas).toBeGreaterThan(0);
    // O runner customizado devolveu sucesso (sem bytes => dump sem conteudo
    // é falha, mas o que importa é que ELE foi chamado).
    expect(result).toBeTruthy();
  });

  it("com runProcess customizado no restore, o customizado é o usado", async () => {
    const inFile = path.join(workDir, "entrada.archive");
    fs.writeFileSync(inFile, "conteudo");
    let chamadas = 0;
    const custom = async () => {
      chamadas += 1;
      return fakeResult();
    };

    await restoreLib.restoreDatabase({
      dbType: "mongodb",
      containerName: "app-mongo-1",
      username: "",
      password: "",
      inFile,
      preRestoreDir: path.join(workDir, "pre-restore"),
      lockDir: path.join(workDir, "locks"),
      runProcess: custom,
    });

    expect(chamadas).toBeGreaterThan(0);
  });
});
