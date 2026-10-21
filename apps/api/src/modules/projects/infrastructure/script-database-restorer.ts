import { Injectable, Logger } from "@nestjs/common";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseRestorer, DatabaseRestoreStatus, StartRestoreOptions } from "../domain/database-restorer";
import { isProcessAlive, PROGRESS_STALE_MS, readBackupProgress } from "./backup-progress";

const STEP_MARKER = "__KORRELO_DBRESTORE_STEP__";
const DONE_MARKER = "__KORRELO_DBRESTORE_DONE__";
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

@Injectable()
export class ScriptDatabaseRestorer implements DatabaseRestorer {
  private readonly logger = new Logger(ScriptDatabaseRestorer.name);

  private get stateRoot(): string {
    return process.env.KORRELO_STATE_DIR || path.join(os.homedir(), ".korrelo");
  }

  private get stateDir(): string {
    return path.join(this.stateRoot, "database-restore");
  }

  private logPath(projectId: string): string {
    return path.join(this.stateDir, `${projectId}.log`);
  }

  private progressPath(projectId: string): string {
    return path.join(this.stateDir, `${projectId}.progress.json`);
  }

  private get backupRoot(): string {
    return process.env.BACKUP_DIR || path.join(os.homedir(), "korrelo-backups");
  }
  private get repoDir(): string {
    return path.resolve(process.cwd(), "..", "..");
  }

  async start(projectId: string, options: StartRestoreOptions): Promise<{ alreadyRunning: boolean }> {
    const current = await this.getStatus(projectId);
    if (current.running) {
      return { alreadyRunning: true };
    }

    fs.mkdirSync(this.stateDir, { recursive: true });
    const logPath = this.logPath(projectId);
    fs.writeFileSync(logPath, "");
    // Progresso do job anterior não pode vazar pro job novo (senão o
    // painel lê "último progresso" velho e julga o job novo como morto
    // antes dele começar).
    fs.rmSync(this.progressPath(projectId), { force: true });

    const scriptPath = path.join(this.repoDir, "scripts", "restore-database.sh");
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
        IN_FILE: options.backupFilePath,
        // O backup de segurança (estado atual do banco) fica num lugar
        // próprio e identificável - nunca é apagado pelo próprio restore.
        KORRELO_PRE_RESTORE_DIR: path.join(this.backupRoot, "pre-restore"),
        KORRELO_PROGRESS_FILE: this.progressPath(projectId),
        KORRELO_JOB_ID: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        KORRELO_PROJECT_ID: projectId,
        KORRELO_BACKUP_ROOT: this.backupRoot,
      },
    });
    child.unref();
    fs.closeSync(out);

    this.logger.log(`Restauração de banco disparada pro projeto ${projectId} (pid ${child.pid}).`);
    return { alreadyRunning: false };
  }

  async getStatus(projectId: string): Promise<DatabaseRestoreStatus> {
    const logPath = this.logPath(projectId);
    if (!fs.existsSync(logPath)) {
      return { running: false, label: "", done: false, success: null, log: "" };
    }

    const log = fs.readFileSync(logPath, "utf-8");
    const parsed = this.parseLog(log);
    if (parsed.done) {
      return { ...parsed, running: false };
    }

    // Progresso do job (heartbeat do motor): enquanto ele atualiza, o
    // restore está VIVO - um restore grande pode levar horas.
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
        errorMessage: "A restauração parou de responder.",
        bytesWritten: progress.bytesWritten,
        startedAt: progress.startedAt,
        lastProgressAt: lastProgressAt || null,
      };
    }

    // Sem arquivo de progresso (job iniciado antes desta versão): fallback
    // pro comportamento antigo, baseado no mtime do log.
    const stats = fs.statSync(logPath);
    if (Date.now() - stats.mtimeMs > STALE_THRESHOLD_MS) {
      return {
        ...parsed,
        running: false,
        done: true,
        success: false,
        errorMessage: "A restauração parou de responder (timeout).",
      };
    }

    return { ...parsed, running: true };
  }

  private parseLog(log: string): Omit<DatabaseRestoreStatus, "running"> {
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
