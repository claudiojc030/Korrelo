import { Injectable, Logger } from "@nestjs/common";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { UpdateChecker, UpdateStatus } from "../domain/update-checker";

const execFile = promisify(execFileCallback);
const GIT_TIMEOUT_MS = 15_000;

const NOT_CHECKED: UpdateStatus = {
  checked: false,
  currentCommit: null,
  remoteCommit: null,
  commitsBehind: 0,
  updateAvailable: false,
};

// Compara o commit local com o HEAD do remoto via `git` puro, sem chamar a
// API do GitHub. Funciona igual em repositório público ou privado, usando
// as mesmas credenciais (SSH/HTTPS) já configuradas no `git clone` original.
// Se não houver remote configurado (dev local) ou a rede falhar, devolve
// "não verificado" em vez de quebrar, porque isso nunca deve travar o dashboard.
@Injectable()
export class GitUpdateChecker implements UpdateChecker {
  private readonly logger = new Logger(GitUpdateChecker.name);

  async check(): Promise<UpdateStatus> {
    try {
      const cwd = process.cwd();
      const opts = { cwd, timeout: GIT_TIMEOUT_MS };

      const { stdout: branchOut } = await execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], opts);
      const branch = branchOut.trim();

      const { stdout: currentOut } = await execFile("git", ["rev-parse", "HEAD"], opts);
      const currentCommit = currentOut.trim();

      await execFile("git", ["fetch", "--quiet", "origin", branch], opts);

      const { stdout: remoteOut } = await execFile("git", ["rev-parse", `origin/${branch}`], opts);
      const remoteCommit = remoteOut.trim();

      const { stdout: countOut } = await execFile(
        "git",
        ["rev-list", "--count", `HEAD..origin/${branch}`],
        opts,
      );
      const commitsBehind = Number.parseInt(countOut.trim(), 10) || 0;

      return {
        checked: true,
        currentCommit,
        remoteCommit,
        commitsBehind,
        updateAvailable: commitsBehind > 0,
      };
    } catch (error) {
      this.logger.warn(`Não foi possível checar atualização (sem remote configurado ou sem rede?): ${error}`);
      return NOT_CHECKED;
    }
  }
}
