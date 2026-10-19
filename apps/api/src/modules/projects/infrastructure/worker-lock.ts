import { Injectable, Logger } from "@nestjs/common";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Lock de worker em arquivo.
 *
 * POR QUE UM LOCK EM ARQUIVO E NÃO SÓ "CONCURRÊNCIA = 1 NO CÓDIGO":
 * o Core roda em PM2, e ninguém impede que alguém suba uma segunda
 * instância da API (ou um segundo nó apontando pro mesmo SQLite). Duas
 * instâncias processando a fila ao mesmo tempo = dois builds simultâneos,
 * que é exatamente o que a Wave 2 quer impedir. O lock em arquivo é a
 *_barreira entre processos na mesma máquina_.
 *
 * COMO FUNCIONA:
 * - criação EXCLUSIVA do arquivo (`wx`): o sistema operacional garante que
 *   só um processo cria o arquivo por vez (O_EXCL). É atômico em FS local.
 * - o arquivo guarda o PID de quem pegou o lock + quando.
 * - o worker RENOVA o lock (touch) de tempos em tempos enquanto trabalha: se
 *   o processo morre, o "batimento" para e outro pode assumir depois do
 *   timeout de lock órfão.
 *
 * LIMITAÇÕES (documentadas de propósito):
 * - depende de O_EXCL ser atômico: vale em FS local (ext4/xfs/btrfs/APFS/NTFS).
 *   Em NFS/SMB o `wx` pode não ser atômico - não usar o Core com o SQLite
 *   em rede sem revisar isto.
 * - o timeout de lock órfão é heurístico: se um build legítimo passar do
 *   timeout, outra instância poderia tomar o lock. O padrão (30min) é maior
 *   que qualquer build plausível numa VPS pequena, e o heartbeat reduz o
 *   risco ainda mais.
 */
const ORPHANED_LOCK_TIMEOUT_MS = 30 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

export interface LockHandle {
  path: string;
  acquiredAt: number;
}

@Injectable()
export class WorkerLock {
  private readonly logger = new Logger(WorkerLock.name);
  private handle: LockHandle | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  private get lockPath(): string {
    // O diretório do lock pode ser apontado pra outro lugar (usado nos
    // testes pra não sujar o home de quem roda a suíte).
    const baseDir = process.env.KORRELO_LOCK_DIR ?? path.join(os.homedir(), ".korrelo");
    return path.join(baseDir, "deploy-worker.lock");
  }

  /** Tenta pegar o lock. Devolve false se outro worker está com ele. */
  async acquire(): Promise<boolean> {
    if (this.handle) return true;

    const lockPath = this.lockPath;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(lockPath, "wx");
        const acquiredAt = Date.now();
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt }));
        fs.closeSync(fd);
        this.handle = { path: lockPath, acquiredAt };
        this.startHeartbeat();
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          this.logger.warn(`[deploy] não foi possível criar o lock do worker: ${(error as Error).message}`);
          return false;
        }

        // Já existe: é um lock órfão (o processo morreu) ou um worker ativo?
        if (this.isStale(lockPath)) {
          this.logger.warn("[deploy] lock do worker abandonado - assumindo");
          try {
            fs.rmSync(lockPath, { force: true });
          } catch {
            return false;
          }
          continue;
        }
        return false;
      }
    }

    return false;
  }

  async release(): Promise<void> {
    this.stopHeartbeat();
    if (!this.handle) return;
    try {
      fs.rmSync(this.handle.path, { force: true });
    } catch {
      // Nada a fazer: o próximo boot detecta o lock órfão.
    }
    this.handle = null;
  }

  /** true quando este processo é o dono do lock. */
  isHeldByMe(): boolean {
    return this.handle !== null;
  }

  private isStale(lockPath: string): boolean {
    try {
      const stat = fs.statSync(lockPath);
      const age = Date.now() - stat.mtimeMs;
      if (age > ORPHANED_LOCK_TIMEOUT_MS) return true;
      // PID morto? (o lock foi criado por um processo que não existe mais)
      const content = fs.readFileSync(lockPath, "utf-8");
      const parsed = JSON.parse(content) as { pid?: number };
      if (parsed.pid && !isProcessAlive(parsed.pid)) return true;
      return false;
    } catch {
      return true;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (!this.handle) return;
      try {
        const now = new Date();
        fs.utimesSync(this.handle.path, now, now);
      } catch {
        // Se o sumiu (removido na mão), o próximo acquire() recria.
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM = o processo existe, mas é de outro usuário.
    return code === "EPERM";
  }
}
