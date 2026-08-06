import { Injectable, Logger } from "@nestjs/common";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseExporter, DatabaseExportStatus, StartExportOptions } from "../domain/database-exporter";

const STEP_MARKER = "__KORRELO_DBEXPORT_STEP__";
const DONE_MARKER = "__KORRELO_DBEXPORT_DONE__";
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

const EXTENSION_BY_TYPE: Record<StartExportOptions["dbType"], string> = {
  postgres: "sql",
  mongodb: "archive",
  redis: "rdb",
};

@Injectable()
export class ScriptDatabaseExporter implements DatabaseExporter {
  private readonly logger = new Logger(ScriptDatabaseExporter.name);

  private get exportsDir(): string {
    return path.join(os.homedir(), "korrelo-backups", "exports");
  }

  private get stateDir(): string {
    return path.join(os.homedir(), ".korrelo", "database-export");
  }

  private logPath(projectId: string): string {
    return path.join(this.stateDir, `${projectId}.log`);
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
    fs.mkdirSync(this.exportsDir, { recursive: true });
    const logPath = this.logPath(projectId);
    fs.writeFileSync(logPath, "");

    const outFile = this.outFilePath(projectId, options.dbType);
    fs.rmSync(outFile, { force: true });

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
    const match = fs.readdirSync(dir).find((name) => name.startsWith(`${projectId}.`));
    return match ? path.join(dir, match) : null;
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
