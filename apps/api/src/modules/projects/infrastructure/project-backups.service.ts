import { Injectable } from "@nestjs/common";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Project } from "../domain/project.entity";
import type { DatabaseType } from "../domain/managed-database.entity";

export interface ProjectBackupEntry {
  id: string;
  createdAt: Date;
  dbType: Exclude<DatabaseType, "custom">;
  fileName: string;
  sizeBytes: number;
}

const EXTENSION_BY_TYPE: Record<Exclude<DatabaseType, "custom">, string> = {
  postgres: "sql",
  mongodb: "archive",
  redis: "rdb",
};

// Mesma normalização usada por scripts/backup.js (cron diário) pra nomear os
// arquivos por projeto - precisa bater exatamente, senão a listagem não acha
// nada pro projeto certo.
export function safeProjectName(name: string): string {
  return name.replace(/[^a-z0-9-]+/gi, "-");
}

export function backupFileName(project: Project, dbType: Exclude<DatabaseType, "custom">): string {
  return `${safeProjectName(project.name)}-${dbType}.${EXTENSION_BY_TYPE[dbType]}`;
}

// "2026-08-14T03-00-01-234Z" -> Date. new Date(...) direto não entende esse
// formato (dois-pontos viraram hífen pra caber num nome de pasta), então
// reconstrói o ISO original antes de parsear.
function parseBackupTimestamp(dirName: string): Date | null {
  const match = dirName.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  if (!match) return null;
  const [, date, hh, mm, ss, ms] = match;
  const parsed = new Date(`${date}T${hh}:${mm}:${ss}.${ms}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

@Injectable()
export class ProjectBackupsService {
  get backupRoot(): string {
    return process.env.BACKUP_DIR || path.join(os.homedir(), "korrelo-backups");
  }

  async list(project: Project, dbType: Exclude<DatabaseType, "custom">): Promise<ProjectBackupEntry[]> {
    const safeName = safeProjectName(project.name);
    const targetFileName = `${safeName}-${dbType}.${EXTENSION_BY_TYPE[dbType]}`;

    let dirEntries: import("node:fs").Dirent[];
    try {
      dirEntries = await fs.readdir(this.backupRoot, { withFileTypes: true });
    } catch {
      return [];
    }

    const entries: ProjectBackupEntry[] = [];
    for (const entry of dirEntries) {
      if (!entry.isDirectory()) continue;
      const createdAt = parseBackupTimestamp(entry.name);
      if (!createdAt) continue; // pula "exports/" e qualquer outra coisa que não seja um snapshot diário

      const filePath = path.join(this.backupRoot, entry.name, targetFileName);
      try {
        const stat = await fs.stat(filePath);
        entries.push({ id: entry.name, createdAt, dbType, fileName: targetFileName, sizeBytes: stat.size });
      } catch {
        // Esse dia não tem backup desse projeto (falhou, ou o banco foi provisionado depois).
      }
    }

    return entries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async resolvePath(
    project: Project,
    backupId: string,
    dbType: Exclude<DatabaseType, "custom">,
  ): Promise<{ filePath: string; fileName: string } | null> {
    // backupId vem direto de um @Param de URL - valida contra o mesmo formato
    // de timestamp usado pra criar as pastas, pra nunca virar um path traversal.
    if (!parseBackupTimestamp(backupId)) return null;

    const safeName = safeProjectName(project.name);
    const fileName = `${safeName}-${dbType}.${EXTENSION_BY_TYPE[dbType]}`;
    const filePath = path.join(this.backupRoot, backupId, fileName);
    try {
      await fs.access(filePath);
    } catch {
      return null;
    }
    return { filePath, fileName };
  }
}
