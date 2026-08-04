import { Injectable, Logger } from "@nestjs/common";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MongoImporter, MongoImportStatus } from "../domain/mongo-importer";

const STEP_MARKER = "__KORRELO_MONGOIMPORT_STEP__";
const DONE_MARKER = "__KORRELO_MONGOIMPORT_DONE__";
// Dump/restore de bancos grandes pode levar bem mais que uma atualização do
// Korrelo, por isso o limiar de "travou" é maior que o do self-updater.
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

@Injectable()
export class ScriptMongoImporter implements MongoImporter {
  private readonly logger = new Logger(ScriptMongoImporter.name);

  private get stateDir(): string {
    return path.join(os.homedir(), ".korrelo", "mongo-import");
  }

  private logPath(projectId: string): string {
    return path.join(this.stateDir, `${projectId}.log`);
  }

  private get repoDir(): string {
    // ecosystem.config.js roda a API com cwd "./apps/api" a partir da raiz do
    // repo, então subir dois níveis sempre chega na raiz.
    return path.resolve(process.cwd(), "..", "..");
  }

  async start(
    projectId: string,
    containerName: string,
    sourceUri: string,
    targetUri: string,
  ): Promise<{ alreadyRunning: boolean }> {
    const current = await this.getStatus(projectId);
    if (current.running) {
      return { alreadyRunning: true };
    }

    fs.mkdirSync(this.stateDir, { recursive: true });
    const logPath = this.logPath(projectId);
    fs.writeFileSync(logPath, "");

    const scriptPath = path.join(this.repoDir, "scripts", "mongo-import.sh");
    const out = fs.openSync(logPath, "a");

    // As connection strings vão por variável de ambiente, não por argumento
    // de linha de comando, pra não ficarem visíveis em "ps aux".
    const child = spawn("bash", [scriptPath], {
      cwd: this.repoDir,
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, SOURCE_URI: sourceUri, TARGET_URI: targetUri, CONTAINER_NAME: containerName },
    });
    child.unref();
    fs.closeSync(out);

    this.logger.log(`Importação de MongoDB disparada pro projeto ${projectId} (pid ${child.pid}).`);
    return { alreadyRunning: false };
  }

  async getStatus(projectId: string): Promise<MongoImportStatus> {
    const logPath = this.logPath(projectId);
    if (!fs.existsSync(logPath)) {
      return { running: false, percent: 0, label: "", done: false, success: null, log: "" };
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
        errorMessage: "A importação parou de responder (timeout).",
      };
    }

    return { ...parsed, running: true };
  }

  private parseLog(log: string): Omit<MongoImportStatus, "running"> {
    const lines = log.split("\n").filter(Boolean);
    let percent = 0;
    let label = "";
    let done = false;
    let success: boolean | null = null;
    let errorMessage: string | undefined;

    for (const line of lines) {
      if (line.startsWith(STEP_MARKER)) {
        const [, pct, lbl] = line.split("|");
        percent = Number.parseInt(pct, 10) || percent;
        label = lbl ?? label;
      } else if (line.startsWith(DONE_MARKER)) {
        const [, outcome, message] = line.split("|");
        done = true;
        success = outcome === "success";
        errorMessage = message;
      }
    }

    return { percent, label, done, success, errorMessage, log };
  }
}
