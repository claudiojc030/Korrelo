import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Project } from "../domain/project.entity";
import { ProjectBackupsService } from "./project-backups.service";
import { manifestPathFor } from "./backup-manifest";

/**
 * LISTAGEM E DOWNLOAD DE BACKUPS.
 *
 * Regras:
 * - arquivo temporário (.tmp) NUNCA aparece;
 * - backup marcado como incompleto NUNCA aparece nem pode ser baixado;
 * - backup novo (com manifesto) aparece como validado, com sha256;
 * - backup antigo (sem manifesto) CONTINUA aparecendo, mas como legado
 *   (não validado) - nada some da lista.
 */
describe("listagem e download de backups do projeto", () => {
  let workDir: string;
  let previousBackupDir: string | undefined;
  const service = new ProjectBackupsService();

  const project = Project.create("Meu Projeto", "https://github.com/exemplo/meu-projeto");
  const safeName = "Meu-Projeto";
  const stamp = "2026-10-01T03-00-00-000Z";

  function backupDir(id: string): string {
    const dir = path.join(workDir, id);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function writeBackup(dir: string, fileName: string, content: string): string {
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function writeManifest(filePath: string, manifest: Record<string, unknown>): void {
    fs.writeFileSync(manifestPathFor(filePath), JSON.stringify(manifest));
  }

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-backup-list-"));
    previousBackupDir = process.env.BACKUP_DIR;
    process.env.BACKUP_DIR = workDir;
  });

  afterEach(() => {
    if (previousBackupDir === undefined) delete process.env.BACKUP_DIR;
    else process.env.BACKUP_DIR = previousBackupDir;
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("não lista arquivo temporário (dump em andamento)", async () => {
    const dir = backupDir(stamp);
    writeBackup(dir, `${safeName}-mongodb.archive.tmp-abc123`, "parcial");

    const entries = await service.list(project, "mongodb");
    expect(entries).toEqual([]);
  });

  it("não lista backup marcado como incompleto", async () => {
    const dir = backupDir(stamp);
    const filePath = writeBackup(dir, `${safeName}-mongodb.archive`, "conteudo");
    writeManifest(filePath, {
      version: 1,
      status: "incomplete",
      bytes: 8,
      sha256: "x",
      dbType: "mongodb",
      fileName: `${safeName}-mongodb.archive`,
      createdAt: new Date().toISOString(),
      reason: "cron",
      format: "mongodump-archive",
      projectId: project.id,
      serviceName: "mongodb",
      containerName: "proj-mongo-1",
    });

    const entries = await service.list(project, "mongodb");
    expect(entries).toEqual([]);
  });

  it("lista backup novo com manifesto como validado", async () => {
    const dir = backupDir(stamp);
    const filePath = writeBackup(dir, `${safeName}-mongodb.archive`, "conteudo");
    writeManifest(filePath, {
      version: 1,
      status: "complete",
      bytes: 8,
      sha256: "abc123",
      dbType: "mongodb",
      fileName: `${safeName}-mongodb.archive`,
      createdAt: new Date().toISOString(),
      reason: "cron",
      format: "mongodump-archive",
      projectId: project.id,
      serviceName: "mongodb",
      containerName: "proj-mongo-1",
    });

    const entries = await service.list(project, "mongodb");
    expect(entries).toHaveLength(1);
    expect(entries[0].validated).toBe(true);
    expect(entries[0].legacy).toBe(false);
    expect(entries[0].sha256).toBe("abc123");
    expect(entries[0].reason).toBe("cron");
    expect(entries[0].sizeBytes).toBe(8);
    expect(entries[0].id).toBe(stamp);
  });

  it("mantém backup antigo (sem manifesto) aparecendo como legado", async () => {
    const dir = backupDir(stamp);
    writeBackup(dir, `${safeName}-mongodb.archive`, "conteudo-antigo");

    const entries = await service.list(project, "mongodb");
    expect(entries).toHaveLength(1);
    expect(entries[0].validated).toBe(false);
    expect(entries[0].legacy).toBe(true);
    expect(entries[0].sha256).toBeNull();
  });

  it("ordena do mais novo pro mais antigo", async () => {
    const older = backupDir("2026-09-01T03-00-00-000Z");
    const newer = backupDir("2026-10-01T03-00-00-000Z");
    writeBackup(older, `${safeName}-mongodb.archive`, "antigo");
    writeBackup(newer, `${safeName}-mongodb.archive`, "novo");

    const entries = await service.list(project, "mongodb");
    expect(entries.map((entry) => entry.id)).toEqual([
      "2026-10-01T03-00-00-000Z",
      "2026-09-01T03-00-00-000Z",
    ]);
  });

  describe("download", () => {
    it("libera o download de backup concluído", async () => {
      const dir = backupDir(stamp);
      const filePath = writeBackup(dir, `${safeName}-mongodb.archive`, "conteudo");
      writeManifest(filePath, {
        version: 1,
        status: "complete",
        bytes: 8,
        sha256: "abc",
        dbType: "mongodb",
        fileName: `${safeName}-mongodb.archive`,
        createdAt: new Date().toISOString(),
        reason: "cron",
        format: "mongodump-archive",
        projectId: project.id,
        serviceName: "mongodb",
        containerName: "proj-mongo-1",
      });

      const resolved = await service.resolvePath(project, stamp, "mongodb");
      expect(resolved).not.toBeNull();
      expect(resolved!.filePath).toBe(filePath);
      expect(resolved!.fileName).toBe(`${safeName}-mongodb.archive`);
    });

    it("recusa download de backup incompleto", async () => {
      const dir = backupDir(stamp);
      const filePath = writeBackup(dir, `${safeName}-mongodb.archive`, "conteudo");
      writeManifest(filePath, {
        version: 1,
        status: "incomplete",
        bytes: 8,
        sha256: "abc",
        dbType: "mongodb",
        fileName: `${safeName}-mongodb.archive`,
        createdAt: new Date().toISOString(),
        reason: "cron",
        format: "mongodump-archive",
        projectId: project.id,
        serviceName: "mongodb",
        containerName: "proj-mongo-1",
      });

      const resolved = await service.resolvePath(project, stamp, "mongodb");
      expect(resolved).toBeNull();
    });

    it("libera o download de backup legado (não validado, mas existente)", async () => {
      const dir = backupDir(stamp);
      writeBackup(dir, `${safeName}-mongodb.archive`, "conteudo-antigo");

      const resolved = await service.resolvePath(project, stamp, "mongodb");
      expect(resolved).not.toBeNull();
    });

    it("recusa backupId que não é um timestamp (path traversal)", async () => {
      const resolved = await service.resolvePath(project, "../../etc", "mongodb");
      expect(resolved).toBeNull();
    });
  });
});
