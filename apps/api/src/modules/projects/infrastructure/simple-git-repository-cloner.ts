import { Injectable } from "@nestjs/common";
import { promises as fs } from "node:fs";
import simpleGit from "simple-git";
import type { RepositoryCloner } from "../domain/repository-cloner";

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

@Injectable()
export class SimpleGitRepositoryCloner implements RepositoryCloner {
  async cloneOrUpdate(repoUrl: string, destPath: string): Promise<void> {
    const alreadyCloned = await directoryExists(`${destPath}/.git`);

    if (alreadyCloned) {
      await simpleGit(destPath).pull();
      return;
    }

    await fs.mkdir(destPath, { recursive: true });
    // Clone raso: só o commit mais recente. Suficiente para detectar stack e
    // consistente com o orçamento de disco/rede de VPS pequenas.
    await simpleGit().clone(repoUrl, destPath, ["--depth", "1"]);
  }
}
