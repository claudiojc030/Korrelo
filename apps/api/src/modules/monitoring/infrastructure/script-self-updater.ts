import { Injectable, Logger } from "@nestjs/common";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SelfUpdater, SelfUpdateStatus } from "../domain/self-updater";

const STEP_MARKER = "__KORRELO_UPDATE_STEP__";
const DONE_MARKER = "__KORRELO_UPDATE_DONE__";
// Se passar disso sem marcar "done", trata como travado/morto (ex.: VPS
// reiniciou no meio) em vez de bloquear novas tentativas de update pra sempre.
const STALE_THRESHOLD_MS = 10 * 60 * 1000;

@Injectable()
export class ScriptSelfUpdater implements SelfUpdater {
  private readonly logger = new Logger(ScriptSelfUpdater.name);

  private get stateDir(): string {
    return path.join(os.homedir(), ".korrelo");
  }

  private get logPath(): string {
    return path.join(this.stateDir, "update.log");
  }

  private get repoDir(): string {
    // ecosystem.config.js roda a API com cwd "./apps/api" a partir da raiz do
    // repo (mesmo em dev, "npm run start:dev --workspace=apps/api" tem o
    // mesmo cwd), então subir dois níveis sempre chega na raiz.
    return path.resolve(process.cwd(), "..", "..");
  }

  async start(): Promise<{ alreadyRunning: boolean }> {
    const current = await this.getStatus();
    if (current.running) {
      return { alreadyRunning: true };
    }

    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.writeFileSync(this.logPath, "");

    const scriptPath = path.join(this.repoDir, "scripts", "self-update.sh");
    const out = fs.openSync(this.logPath, "a");

    const child = spawn("bash", [scriptPath], {
      cwd: this.repoDir,
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.unref();
    fs.closeSync(out);

    this.logger.log(`Self-update disparado (pid ${child.pid}).`);
    return { alreadyRunning: false };
  }

  async getStatus(): Promise<SelfUpdateStatus> {
    if (!fs.existsSync(this.logPath)) {
      return { running: false, percent: 0, label: "", done: false, success: null, log: "" };
    }

    const log = fs.readFileSync(this.logPath, "utf-8");
    const parsed = this.parseLog(log);
    if (parsed.done) {
      return { ...parsed, running: false };
    }

    const stats = fs.statSync(this.logPath);
    if (Date.now() - stats.mtimeMs > STALE_THRESHOLD_MS) {
      return {
        ...parsed,
        running: false,
        done: true,
        success: false,
        errorMessage: "Processo de atualização parou de responder (timeout).",
      };
    }

    return { ...parsed, running: true };
  }

  private parseLog(log: string): Omit<SelfUpdateStatus, "running"> {
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
