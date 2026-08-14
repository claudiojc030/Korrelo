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

function withAccessToken(repoUrl: string, accessToken?: string): string {
  if (!accessToken || !repoUrl.startsWith("https://github.com/")) return repoUrl;
  return repoUrl.replace("https://github.com/", `https://x-access-token:${accessToken}@github.com/`);
}

@Injectable()
export class SimpleGitRepositoryCloner implements RepositoryCloner {
  async cloneOrUpdate(repoUrl: string, destPath: string, accessToken?: string): Promise<void> {
    const authenticatedUrl = withAccessToken(repoUrl, accessToken);
    const alreadyCloned = await directoryExists(`${destPath}/.git`);

    if (alreadyCloned) {
      // Token de instalação expira em ~1h: sempre atualiza a remote antes do pull,
      // já que a que estava salva no clone anterior pode ter expirado.
      const git = simpleGit(destPath);
      await git.remote(["set-url", "origin", authenticatedUrl]);
      // Esse workspace é só um espelho do repositório, nunca um lugar de
      // trabalho em si - qualquer coisa fora do que está no commit puxado é
      // sobra (arquivo gerado pelo próprio Korrelo em deploy antigo -
      // Dockerfile/.dockerignore/docker-compose.korrelo.yml -, ou um arquivo
      // rastreado que ficou modificado localmente por engano). "git pull"
      // recusa nos dois casos: untracked no caminho de um arquivo que chegou
      // no commit novo, OU tracked com alteração local não commitada. Reset
      // completo pro HEAD antes do pull evita os dois de uma vez.
      await git.raw(["checkout", "--", "."]);
      await git.raw(["clean", "-fd"]);
      await git.pull();
      return;
    }

    await fs.mkdir(destPath, { recursive: true });
    // Clone raso: só o commit mais recente. Suficiente para detectar stack e
    // consistente com o orçamento de disco/rede de VPS pequenas. Sem "-b":
    // pega a branch padrão de verdade do repositório (main, master, o que for).
    await simpleGit().clone(authenticatedUrl, destPath, ["--depth", "1"]);
  }

  async getCurrentBranch(destPath: string): Promise<string | null> {
    try {
      const status = await simpleGit(destPath).status();
      return status.current ?? null;
    } catch {
      return null;
    }
  }

  async getLastCommit(destPath: string): Promise<{ hash: string; message: string } | null> {
    try {
      const log = await simpleGit(destPath).log({ maxCount: 1 });
      const latest = log.latest;
      return latest ? { hash: latest.hash.slice(0, 7), message: latest.message } : null;
    } catch {
      return null;
    }
  }
}
