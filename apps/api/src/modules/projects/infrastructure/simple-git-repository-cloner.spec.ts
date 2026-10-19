import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SimpleGitRepositoryCloner } from "./simple-git-repository-cloner";

/**
 * Teste do checkout do commit exato (Wave 2, achado DEP-09).
 *
 * ANTES: o deploy fazia "git pull" na branch padrão do clone - o
 * `deployBranch` configurado no projeto era ignorado e o commit implantado
 * podia ser outro. AGORA: o workspace vai para o commit registrado no job e
 * o HEAD é verificado.
 *
 * O teste usa um repositório GIT LOCAL (nada de rede, nada de GitHub).
 */
describe("SimpleGitRepositoryCloner.prepareCommit", () => {
  let repoDir: string;
  let cloneDir: string;
  let developCommit: string;

  function git(args: string[], cwd: string): string {
    return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
  }

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-git-src-"));
    cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-git-dst-"));

    git(["init", "-b", "main"], repoDir);
    git(["config", "user.email", "teste@korrelo.local"], repoDir);
    git(["config", "user.name", "Teste Korrelo"], repoDir);

    fs.writeFileSync(path.join(repoDir, "app.js"), "console.log('v1');\n");
    git(["add", "."], repoDir);
    git(["commit", "-m", "commit na main"], repoDir);

    git(["checkout", "-b", "develop"], repoDir);
    fs.writeFileSync(path.join(repoDir, "app.js"), "console.log('v2 na develop');\n");
    git(["add", "."], repoDir);
    git(["commit", "-m", "commit na develop"], repoDir);
    developCommit = git(["rev-parse", "HEAD"], repoDir);

    git(["checkout", "main"], repoDir);
  });

  afterAll(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(cloneDir, { recursive: true, force: true });
  });

  it("coloca o workspace no commit da branch pedida (e não na default)", async () => {
    const cloner = new SimpleGitRepositoryCloner();
    const dest = path.join(cloneDir, "por-branch");

    const result = await cloner.prepareCommit(repoDir, dest, undefined, {
      branch: "develop",
      commitSha: developCommit,
    });

    expect(result.sha).toBe(developCommit);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dest, encoding: "utf-8" }).trim();
    expect(head).toBe(developCommit);
    // O conteúdo é o da develop, não o da main.
    expect(fs.readFileSync(path.join(dest, "app.js"), "utf-8")).toContain("v2 na develop");
  });

  it("implanta o commit pedido mesmo quando a branch já andou", async () => {
    const cloner = new SimpleGitRepositoryCloner();
    const dest = path.join(cloneDir, "commit-antigo");

    // A branch ganha um commit novo depois do job ser criado.
    git(["checkout", "develop"], repoDir);
    fs.writeFileSync(path.join(repoDir, "app.js"), "console.log('v3');\n");
    git(["add", "."], repoDir);
    git(["commit", "-m", "commit novo"], repoDir);
    const newest = git(["rev-parse", "HEAD"], repoDir);
    git(["checkout", "main"], repoDir);

    const result = await cloner.prepareCommit(repoDir, dest, undefined, {
      branch: "develop",
      commitSha: developCommit,
    });

    // O job manda o commit: é ele que é implantado, não a head da branch.
    expect(result.sha).toBe(developCommit);
    expect(result.sha).not.toBe(newest);
  });

  it("falha (em vez de subir outra versão) quando o commit não existe no repositório", async () => {
    const cloner = new SimpleGitRepositoryCloner();
    const dest = path.join(cloneDir, "commit-invalido");

    await expect(
      cloner.prepareCommit(repoDir, dest, undefined, {
        branch: "develop",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
      }),
    ).rejects.toThrow();
  });
});
