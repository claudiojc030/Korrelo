import { Injectable, Logger } from "@nestjs/common";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SELF_UPDATE_JOB_REPOSITORY,
  type SelfUpdateJob,
  type SelfUpdateJobRepository,
} from "../domain/self-update-job.entity";

/**
 * Persistência do job de self-update em ARQUIVOS.
 *
 * ~/.korrelo/self-update/
 *   <id>.json     -> o job (estado completo)
 *   <id>.log      -> o log do runner (append-only, rotacionado)
 *   current.json  -> ponteiro para o job mais recente (written atômico)
 *
 * Nada aqui depende do banco do Core nem do processo da API: o job
 * sobrevive ao restart da API e do Web (e é o que permite classificar um
 * update interrompido no startup).
 */
@Injectable()
export class FileSelfUpdateJobRepository implements SelfUpdateJobRepository {
  private readonly logger = new Logger(FileSelfUpdateJobRepository.name);

  get baseDir(): string {
    return process.env.KORRELO_SELF_UPDATE_DIR ?? path.join(this.stateDir, "self-update");
  }

  private get stateDir(): string {
    return process.env.KORRELO_STATE_DIR ?? path.join(os.homedir(), ".korrelo");
  }

  jobPath(id: string): string {
    return path.join(this.baseDir, `${id}.json`);
  }

  logPath(id: string): string {
    return path.join(this.baseDir, `${id}.log`);
  }

  async save(job: SelfUpdateJob): Promise<SelfUpdateJob> {
    fs.mkdirSync(this.baseDir, { recursive: true });
    const target = this.jobPath(job.id);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
    fs.renameSync(tmp, target);
    // Ponteiro para o job atual (escrita atômica).
    const current = path.join(this.baseDir, "current.json");
    const currentTmp = `${current}.tmp`;
    fs.writeFileSync(currentTmp, JSON.stringify({ id: job.id, updatedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(currentTmp, current);
    return job;
  }

  async findById(id: string): Promise<SelfUpdateJob | null> {
    return this.readJob(this.jobPath(id));
  }

  async findLatest(): Promise<SelfUpdateJob | null> {
    try {
      const pointer = JSON.parse(
        fs.readFileSync(path.join(this.baseDir, "current.json"), "utf-8"),
      ) as { id?: string };
      if (pointer.id) {
        const job = await this.findById(pointer.id);
        if (job) return job;
      }
    } catch {
      /* sem ponteiro: cai para o scan */
    }
    const jobs = await this.list(1);
    return jobs[0] ?? null;
  }

  async list(limit = 20): Promise<SelfUpdateJob[]> {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.baseDir);
    } catch {
      return [];
    }
    const jobs: SelfUpdateJob[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry === "current.json") continue;
      const job = this.readJob(path.join(this.baseDir, entry));
      if (job) jobs.push(job);
    }
    jobs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return jobs.slice(0, limit);
  }

  /** Lê o log do job (com teto de tamanho). */
  readLog(id: string, maxBytes = 200_000): string {
    try {
      const raw = fs.readFileSync(this.logPath(id), "utf-8");
      return raw.length > maxBytes ? raw.slice(-maxBytes) : raw;
    } catch {
      return "";
    }
  }

  private readJob(filePath: string): SelfUpdateJob | null {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as SelfUpdateJob;
    } catch {
      this.logger.warn(`[update] job ilegível: ${filePath}`);
      return null;
    }
  }
}

export { SELF_UPDATE_JOB_REPOSITORY };
