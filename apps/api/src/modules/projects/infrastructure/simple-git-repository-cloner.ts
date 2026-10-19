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

  /**
   * Coloca o workspace no commit exato do job de deploy.
   *
   * Estratégia (sem "git pull" ambíguo):
   * 1. garante o clone e a remote Certainada (o token de instalação expira
   *    em ~1h, então a remote é reescrita a cada deploy);
   * 2. descarta alterações locais (o workspace é do Korrelo, não do usuário);
   * 3. "fetch --depth 1" do commit (ou da branch, quando o commit é
   *    desconhecido - deploy manual);
   * 4. checkout --force do FETCH_HEAD (HEAD destacado, que é o que o build
   *    precisa);
   * 5. VERIFICA o HEAD: se não for o commit esperado, o deploy falha (nunca
   *    subir uma versão diferente da registrada no job).
   */
  async prepareCommit(
    repoUrl: string,
    destPath: string,
    accessToken: string | undefined,
    params: { branch?: string | null; commitSha?: string | null },
  ): Promise<{ sha: string; message: string }> {
    const authenticatedUrl = withAccessToken(repoUrl, accessToken);
    const alreadyCloned = await directoryExists(`${destPath}/.git`);

    if (!alreadyCloned) {
      await fs.mkdir(destPath, { recursive: true });
      // --no-checkout: o checkout é feito logo abaixo, no commit certo.
      await simpleGit().clone(authenticatedUrl, destPath, ["--depth", "1", "--no-checkout"]);
    }

    const git = simpleGit(destPath);
    await git.remote(["set-url", "origin", authenticatedUrl]);

    // Workspace gerenciado pelo Korrelo: alterações locais são sobra.
    await git.raw(["checkout", "--", "."]).catch(() => undefined);
    await git.raw(["clean", "-fd"]).catch(() => undefined);

    const expected = params.commitSha ?? null;
    const ref = expected ?? params.branch ?? "HEAD";

    try {
      await git.raw(["fetch", "--depth", "1", "origin", ref]);
      await git.raw(["checkout", "--force", "FETCH_HEAD"]);
    } catch (error) {
      // Alguns servidores não aceitam fetch por SHA. Fallback: busca a
      // branch (com um pouco de histórico) e checa out o commit dentro dela.
      if (!expected || !params.branch) {
        throw new Error(`Falha ao buscar "${ref}" no repositório: ${(error as Error).message}`);
      }
      await git.raw(["fetch", "--depth", "50", "origin", params.branch]);
      await git.raw(["checkout", "--force", expected]);
    }

    const sha = (await git.raw(["rev-parse", "HEAD"])).trim();
    if (expected && !sha.startsWith(expected) && !expected.startsWith(sha)) {
      throw new Error(
        `O workspace ficou no commit ${sha.slice(0, 7)}, mas o deploy esperava ${expected.slice(0, 7)}.`,
      );
    }

    const message = (await git.raw(["log", "-1", "--format=%s"])).trim();
    return { sha, message };
  }
}
