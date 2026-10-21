import * as fs from "node:fs";

/**
 * ARQUIVO DE PROGRESSO DO BACKUP (lado TypeScript).
 *
 * O motor de dump/restore (scripts/backup-lib) mantém um arquivo JSON
 * com o andamento do job. Isso substitui a heurística antiga de "se o
 * log não foi mexido há 30 minutos, o job morreu" - que dava FALSO
 * POSITIVO em dump grande (um mongodump de 2 horas continua escrevendo,
 * mas pode ficar 30+ minutos sem mexer no log).
 *
 * Enquanto o job está vivo, o motor atualiza esse arquivo pelo menos a
 * cada 10 segundos (heartbeat), independente de bytes novos.
 */
export interface BackupProgress {
  jobId: string | null;
  phase: string;
  bytesWritten: number;
  startedAt: number | null;
  lastProgressAt: number | null;
  pid: number | null;
}

/** Depois disso sem atualizar o progresso, o job é considerado parado. */
export const PROGRESS_STALE_MS = 90 * 1000;

/** Lê o arquivo de progresso (null se não existir/corrompido). */
export function readBackupProgress(filePath: string): BackupProgress | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      jobId: typeof parsed.jobId === "string" ? parsed.jobId : null,
      phase: typeof parsed.phase === "string" ? parsed.phase : "unknown",
      bytesWritten: typeof parsed.bytesWritten === "number" ? parsed.bytesWritten : 0,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : null,
      lastProgressAt: typeof parsed.lastProgressAt === "number" ? parsed.lastProgressAt : null,
      pid: typeof parsed.pid === "number" ? parsed.pid : null,
    };
  } catch {
    return null;
  }
}

/** O processo dono do job ainda existe? */
export function isProcessAlive(pid: number | null): boolean {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = o processo existe, mas é de outro usuário.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}
