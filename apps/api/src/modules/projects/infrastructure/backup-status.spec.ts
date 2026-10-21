import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ScriptDatabaseExporter } from "./script-database-exporter";
import { ScriptDatabaseRestorer } from "./script-database-restorer";
import { manifestPathFor } from "./backup-manifest";

/**
 * STATUS DE EXPORTAÇÃO/RESTAURAÇÃO.
 *
 * O painel acompanha o backup por polling. A heurística antiga ("se o log
 * não foi mexido há 30 minutos, o job morreu") dava FALSO POSITIVO em
 * dump grande. Agora o status usa o arquivo de progresso do motor: enquanto
 * ele é atualizado (heartbeat a cada 10s), o job está VIVO.
 */
describe("status de exportação/restauração de banco", () => {
  let home: string;
  let previousStateDir: string | undefined;
  let previousExportsDir: string | undefined;

  const exporter = new ScriptDatabaseExporter();
  const restorer = new ScriptDatabaseRestorer();

  function stateDir(kind: "database-export" | "database-restore"): string {
    return path.join(home, ".korrelo", kind);
  }

  function writeLog(kind: "database-export" | "database-restore", projectId: string, content: string): string {
    const dir = stateDir(kind);
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, `${projectId}.log`);
    fs.writeFileSync(logPath, content);
    return logPath;
  }

  function writeProgress(
    kind: "database-export" | "database-restore",
    projectId: string,
    progress: Record<string, unknown>,
  ): string {
    const dir = stateDir(kind);
    fs.mkdirSync(dir, { recursive: true });
    const progressPath = path.join(dir, `${projectId}.progress.json`);
    fs.writeFileSync(progressPath, JSON.stringify(progress));
    return progressPath;
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-backup-status-"));
    previousStateDir = process.env.KORRELO_STATE_DIR;
    previousExportsDir = process.env.KORRELO_EXPORTS_DIR;
    process.env.KORRELO_STATE_DIR = path.join(home, ".korrelo");
    process.env.KORRELO_EXPORTS_DIR = path.join(home, "korrelo-backups", "exports");
  });

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env.KORRELO_STATE_DIR;
    else process.env.KORRELO_STATE_DIR = previousStateDir;
    if (previousExportsDir === undefined) delete process.env.KORRELO_EXPORTS_DIR;
    else process.env.KORRELO_EXPORTS_DIR = previousExportsDir;
    fs.rmSync(home, { recursive: true, force: true });
  });

  describe("exportação", () => {
    it("considera o job VIVO com progresso recente, mesmo com log antigo", async () => {
      const projectId = "proj-1";
      const logPath = writeLog("database-export", projectId, "__KORRELO_DBEXPORT_STEP__|10|Exportando banco de dados\n");
      // Log parado há 40 minutos (dump grande que não escreve no log).
      const old = new Date(Date.now() - 40 * 60 * 1000);
      fs.utimesSync(logPath, old, old);

      writeProgress("database-export", projectId, {
        jobId: "job-1",
        phase: "dumping",
        bytesWritten: 123456,
        startedAt: Date.now() - 40 * 60 * 1000,
        lastProgressAt: Date.now(),
        pid: process.pid,
      });

      const status = await exporter.getStatus(projectId);
      expect(status.running).toBe(true);
      expect(status.done).toBe(false);
      expect(status.bytesWritten).toBe(123456);
      expect(status.startedAt).toBeTruthy();
      expect(status.lastProgressAt).toBeTruthy();
    });

    it("marca o job como falho quando o progresso parou e o processo morreu", async () => {
      const projectId = "proj-2";
      writeLog("database-export", projectId, "__KORRELO_DBEXPORT_STEP__|10|Exportando banco de dados\n");
      writeProgress("database-export", projectId, {
        jobId: "job-2",
        phase: "dumping",
        bytesWritten: 10,
        startedAt: Date.now() - 60 * 60 * 1000,
        lastProgressAt: Date.now() - 60 * 60 * 1000,
        pid: 999999999,
      });

      const status = await exporter.getStatus(projectId);
      expect(status.running).toBe(false);
      expect(status.done).toBe(true);
      expect(status.success).toBe(false);
      expect(status.errorMessage).toBeTruthy();
    });

    it("respeita o marcador de conclusão", async () => {
      const projectId = "proj-3";
      writeLog(
        "database-export",
        projectId,
        "__KORRELO_DBEXPORT_STEP__|10|Exportando\n__KORRELO_DBEXPORT_DONE__|success\n",
      );

      const status = await exporter.getStatus(projectId);
      expect(status.done).toBe(true);
      expect(status.running).toBe(false);
      expect(status.success).toBe(true);
    });

    it("ignora arquivo temporário e manifesto ao escolher o arquivo exportado", async () => {
      const projectId = "proj-4";
      const exportsDir = path.join(home, "korrelo-backups", "exports");
      fs.mkdirSync(exportsDir, { recursive: true });
      const filePath = path.join(exportsDir, `${projectId}.archive`);
      fs.writeFileSync(filePath, "conteudo");
      fs.writeFileSync(
        manifestPathFor(filePath),
        JSON.stringify({ version: 1, status: "complete", bytes: 8, sha256: "abc" }),
      );
      fs.writeFileSync(path.join(exportsDir, `${projectId}.archive.tmp-job`), "parcial");

      const resolved = await exporter.getFilePath(projectId);
      expect(resolved).toBe(filePath);
    });

    it("não serve para download um export marcado como incompleto", async () => {
      const projectId = "proj-5";
      const exportsDir = path.join(home, "korrelo-backups", "exports");
      fs.mkdirSync(exportsDir, { recursive: true });
      const filePath = path.join(exportsDir, `${projectId}.archive`);
      fs.writeFileSync(filePath, "conteudo");
      fs.writeFileSync(
        manifestPathFor(filePath),
        JSON.stringify({ version: 1, status: "incomplete", bytes: 8, sha256: "x" }),
      );

      const resolved = await exporter.getFilePath(projectId);
      expect(resolved).toBeNull();
    });
  });

  describe("restauração", () => {
    it("considera o job VIVO com progresso recente", async () => {
      const projectId = "proj-6";
      const logPath = writeLog("database-restore", projectId, "__KORRELO_DBRESTORE_STEP__|30|Restaurando\n");
      const old = new Date(Date.now() - 40 * 60 * 1000);
      fs.utimesSync(logPath, old, old);

      writeProgress("database-restore", projectId, {
        jobId: "job-6",
        phase: "restoring",
        bytesWritten: 4096,
        startedAt: Date.now() - 40 * 60 * 1000,
        lastProgressAt: Date.now(),
        pid: process.pid,
      });

      const status = await restorer.getStatus(projectId);
      expect(status.running).toBe(true);
      expect(status.done).toBe(false);
      expect(status.bytesWritten).toBe(4096);
    });

    it("marca o job como falho quando o progresso parou e o processo morreu", async () => {
      const projectId = "proj-7";
      writeLog("database-restore", projectId, "__KORRELO_DBRESTORE_STEP__|30|Restaurando\n");
      writeProgress("database-restore", projectId, {
        jobId: "job-7",
        phase: "restoring",
        bytesWritten: 10,
        startedAt: Date.now() - 60 * 60 * 1000,
        lastProgressAt: Date.now() - 60 * 60 * 1000,
        pid: 999999999,
      });

      const status = await restorer.getStatus(projectId);
      expect(status.running).toBe(false);
      expect(status.done).toBe(true);
      expect(status.success).toBe(false);
    });
  });
});
