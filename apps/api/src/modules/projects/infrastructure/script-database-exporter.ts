import { Injectable, Logger } from "@nestjs/common";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseExporter, DatabaseExportStatus, StartExportOptions } from "../domain/database-exporter";
import { isTempBackupName, readBackupState } from "./backup-manifest";
import { isProcessAlive, PROGRESS_STALE_MS, readBackupProgress } from "./backup-progress";

const STEP_MARKER = "__KORRELO_DBEXPORT_STEP__";
const DONE_MARKER = "__KORRELO_DBEXPORT_DONE__";
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

const EXTENSION_BY_TYPE: Record<StartExportOptions["dbType"], string> = {
  postgres: "sql",
  mongodb: "archive",
  redis: "rdb",
};

const KNOWN_EXTENSIONS = [".sql", ".archive", ".rdb"];

@Injectable()
export class ScriptDatabaseExporter implements DatabaseExporter {
  private readonly logger = new Logger(ScriptDatabaseExporter.name);

  private get exportsDir(): string {
    return process.env.KORRELO_EXPORTS_DIR || path.join(os.homedir(), "korrelo-backups", "exports");
  }

  private get stateRoot(): string {
    return process.env.KORRELO_STATE_DIR || path.join(os.homedir(), ".korrelo");
  }

  private get stateDir(): string {
    return path.join(this.stateRoot, "database-export");
  }

  private logPath(projectId: string): string {
    return path.join(this.stateDir, `${projectId}.log`);
  }

  private progressPath(projectId: string): string {
    return path.join(this.stateDir, `${projectId}.progress.json`);
  }

  private outFilePath(projectId: string, dbType: StartExportOptions["dbType"]): string {
    return path.join(this.exportsDir, `${projectId}.${EXTENSION_BY_TYPE[dbType]}`);
  }

  private get repoDir(): string {
    return path.resolve(process.cwd(), "..", "..");
  }

  async start(projectId: string, options: StartExportOptions): Promise<{ alreadyRunning: boolean }> {
    const current = await this.getStatus(projectId);
    if (current.running) {
      return { alreadyRunning: true };
    }

    fs.mkdirSync(this.stateDir, { recursive: true });
    const logPath = this.logPath(projectId);
    fs.writeFileSync(logPath, "");
    // O arquivo de progresso do job ANTERIOR é removido: se ele sobreviver,
    // um job novo que ainda nem começou a escrever progresso herda o
    // "último progresso" velho e o painel pode declarar o job novo como
    // falho (falso negativo) logo no primeiro polling.
    fs.rmSync(this.progressPath(projectId), { force: true });

    let outFile: string;
    if (options.destDir && options.fileName) {
      fs.mkdirSync(options.destDir, { recursive: true });
      outFile = path.join(options.destDir, options.fileName);
    } else {
      fs.mkdirSync(this.exportsDir, { recursive: true });
      outFile = this.outFilePath(projectId, options.dbType);
    }
    // O arquivo anterior NÃO é apagado aqui de propósito: o dump novo é
    // escrito em arquivo temporário e só substitui o antigo por rename
    // quando termina com sucesso (ver scripts/backup-lib/dump.cjs). Assim
    // uma exportação que falha não deixa o usuário sem backup nenhum.

    const scriptPath = path.join(this.repoDir, "scripts", "export-database.sh");
    const out = fs.openSync(logPath, "a");

    const child = spawn("bash", [scriptPath], {
      cwd: this.repoDir,
      detached: true,
      stdio: ["ignore", out, out],
      env: {
        ...process.env,
        CONTAINER_NAME: options.containerName,
        DB_TYPE: options.dbType,
        DB_USERNAME: options.username ?? "",
        DB_PASSWORD: options.password ?? "",
        DB_NAME: options.databaseName ?? "",
        OUT_FILE: outFile,
        // Progresso/identificação do job: é o que permite saber se o dump
        // continua vivo (bytes avançando) em vez de inferir por "log parou".
        KORRELO_PROGRESS_FILE: this.progressPath(projectId),
        KORRELO_JOB_ID: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        KORRELO_PROJECT_ID: projectId,
        KORRELO_REASON: options.destDir && options.fileName ? "manual" : "export",
        KORRELO_BACKUP_ROOT: process.env.BACKUP_DIR || path.join(os.homedir(), "korrelo-backups"),
      },
    });
    child.unref();
    fs.closeSync(out);

    this.logger.log(`Exportação de banco disparada pro projeto ${projectId} (pid ${child.pid}).`);
    return { alreadyRunning: false };
  }

  async getStatus(projectId: string): Promise<DatabaseExportStatus> {
    const logPath = this.logPath(projectId);
    if (!fs.existsSync(logPath)) {
      return { running: false, label: "", done: false, success: null, log: "" };
    }

    const log = fs.readFileSync(logPath, "utf-8");
    const parsed = this.parseLog(log);
    if (parsed.done) {
      return { ...parsed, running: false };
    }

    // Progresso do job: enquanto o motor estiver escrevendo (heartbeat a
    // cada 10s), o job está VIVO - mesmo que o dump leve horas.
    const progress = readBackupProgress(this.progressPath(projectId));
    if (progress) {
      const lastProgressAt = progress.lastProgressAt ?? 0;
      const age = Date.now() - lastProgressAt;
      const alive = isProcessAlive(progress.pid);

      if (age <= PROGRESS_STALE_MS || alive) {
        return {
          ...parsed,
          running: true,
          bytesWritten: progress.bytesWritten,
          startedAt: progress.startedAt,
          lastProgressAt: lastProgressAt || null,
        };
      }

      return {
        ...parsed,
        running: false,
        done: true,
        success: false,
        errorMessage: "A exportação parou de responder.",
        bytesWritten: progress.bytesWritten,
        startedAt: progress.startedAt,
        lastProgressAt: lastProgressAt || null,
      };
    }

    // Sem arquivo de progresso (job iniciado antes desta versão): cai no
    // comportamento antigo, baseado no mtime do log.
    const stats = fs.statSync(logPath);
    if (Date.now() - stats.mtimeMs > STALE_THRESHOLD_MS) {
      return {
        ...parsed,
        running: false,
        done: true,
        success: false,
        errorMessage: "A exportação parou de responder (timeout).",
      };
    }

    return { ...parsed, running: true };
  }

  async getFilePath(projectId: string): Promise<string | null> {
    const dir = this.exportsDir;
    if (!fs.existsSync(dir)) return null;

    const candidates = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(`${projectId}.`))
      // Ignora manifesto e arquivos temporários (dump em andamento).
      .filter((name) => !name.endsWith(".manifest.json"))
      .filter((name) => !isTempBackupName(name))
      .filter((name) => KNOWN_EXTENSIONS.some((extension) => name.endsWith(extension)));

    for (const name of candidates) {
      const candidate = path.join(dir, name);
      // Backup marcado como incompleto não é servido para download.
      const state = await readBackupState(candidate);
      if (state.state === "incomplete") continue;
      return candidate;
    }

    return null;
  }

  private parseLog(log: string): Omit<DatabaseExportStatus, "running"> {
    const lines = log.split("\n").filter(Boolean);
    let label = "";
    let done = false;
    let success: boolean | null = null;
    let errorMessage: string | undefined;

    for (const line of lines) {
      if (line.startsWith(STEP_MARKER)) {
        const [, , lbl] = line.split("|");
        label = lbl ?? label;
      } else if (line.startsWith(DONE_MARKER)) {
        const [, outcome, message] = line.split("|");
        done = true;
        success = outcome === "success";
        errorMessage = message;
      }
    }

    return { label, done, success, errorMessage, log };
  }
}
