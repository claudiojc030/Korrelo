import { Injectable } from "@nestjs/common";
import { promises as fs } from "node:fs";
import * as path from "node:path";

async function directorySizeBytes(dirPath: string): Promise<number> {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += await directorySizeBytes(entryPath);
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(entryPath);
        total += stat.size;
      } catch {
        // arquivo pode ter sumido entre o readdir e o stat; ignora.
      }
    }
  }

  return total;
}

@Injectable()
export class ProjectDiskUsageService {
  async getUsageMb(projectPath: string): Promise<number> {
    const bytes = await directorySizeBytes(projectPath);
    return Math.round((bytes / 1024 / 1024) * 10) / 10;
  }
}
