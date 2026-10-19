import { Injectable, Logger } from "@nestjs/common";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SelfUpdater, SelfUpdateStatus } from "../domain/self-updater";
import { formatDirtyWorkingTreeMessage, inspectWorkingTree } from "../../../infrastructure/git-working-tree";
import { DeployQueueService } from "../../projects/infrastructure/deploy-queue.service";

const STEP_MARKER = "__KORRELO_UPDATE_STEP__";
const DONE_MARKER = "__KORRELO_UPDATE_DONE__";
// Se o update morrer no meio e ninguém liberar o drain, os deploys voltam
// sozinhos depois deste tempo (o mesmo TTL do arquivo de drain).
const STALE_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * Self-update do KORRELO.
 *
 * Wave 2.5 - o update do Core NUNCA pode:
 * - rodar no meio de um deploy de projeto (bloqueia se houver);
 * - descartar alteração local do working tree (aborta se estiver sujo);
 * - tocar em container, volume, rede ou banco de projeto (o script só
 *   builda o Core).
 *
 * O que ele FAZ: drena o worker de deploy, faz backup do banco do Core,
 * atualiza o código, aplica as migrations, reinicia o PM2 do Core e
 * libera o worker.
 */
@Injectable()
export class ScriptSelfUpdater implements SelfUpdater {
  private readonly logger = new Logger(ScriptSelfUpdater.name);

  constructor(private readonly deployQueue: DeployQueueService) {}

  private get stateDir(): string {
    // KORRELO_STATE_DIR permite apontar para outro lugar (testes).
    return process.env.KORRELO_STATE_DIR ?? path.join(os.homedir(), ".korrelo");
  }

  private get logPath(): string {
    return path.join(this.stateDir, "update.log");
  }

  private get repoDir(): string {
    // ecosystem.config.js roda a API com cwd "./apps/api" a partir da raiz do
    // repo (mesmo em dev, "npm run start:dev --workspace=apps/api" tem o
    // mesmo cwd), então subir dois níveis sempre chega na raiz.
    // KORRELO_REPO_DIR permite apontar para outro lugar (testes).
    return process.env.KORRELO_REPO_DIR
      ? path.resolve(process.env.KORRELO_REPO_DIR)
      : path.resolve(process.cwd(), "..", "..");
  }

  async start(): Promise<{ alreadyRunning: boolean }> {
    const current = await this.getStatus();
    if (current.running) {
      return { alreadyRunning: true };
    }

    // ------------------------------------------------------------------
    // 1. Working tree limpo? (o caso real: package-lock.json modificado)
    // ------------------------------------------------------------------
    const workingTree = await inspectWorkingTree(this.repoDir);
    if (!workingTree.clean) {
      // NÃO descarta nada - aborta e explica.
      throw new Error(formatDirtyWorkingTreeMessage(workingTree));
    }

    // ------------------------------------------------------------------
    // 2. Nenhum deploy de projeto em andamento
    // ------------------------------------------------------------------
    if (await this.deployQueue.hasActiveJob()) {
      throw new Error(
        "Existe um deploy de projeto em andamento: a atualização do Korrelo foi recusada. " +
          "Nenhum rollout do Core começa no meio de um deploy - tente novamente assim que o deploy terminar.",
      );
    }

    // ------------------------------------------------------------------
    // 3. DRAIN: nenhum novo deploy começa até o update terminar
    // ------------------------------------------------------------------
    await this.deployQueue.drain("atualização do Korrelo");

    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.writeFileSync(this.logPath, "");

    const scriptPath = path.join(this.repoDir, "scripts", "self-update.sh");
    const out = fs.openSync(this.logPath, "a");

    // O PM2 roda a API com NODE_ENV=production (ver ecosystem.config.js), e
    // isso é herdado pelo processo filho por padrão. Com NODE_ENV=production
    // no ambiente, "npm install" pula as devDependencies (typescript entre
    // elas), quebrando o build logo na primeira etapa por falta do "tsc".
    const updateEnv = { ...process.env };
    delete updateEnv.NODE_ENV;

    const child = spawn("bash", [scriptPath], {
      cwd: this.repoDir,
      detached: true,
      stdio: ["ignore", out, out],
      env: updateEnv,
    });
    child.unref();
    fs.closeSync(out);

    this.logger.log(`[update] self-update disparado (pid ${child.pid})`);
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
