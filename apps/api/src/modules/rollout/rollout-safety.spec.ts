import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

jest.mock("node:child_process", () => {
  const actual = jest.requireActual("node:child_process");
  return { ...actual, spawn: jest.fn() };
});

import { formatDirtyWorkingTreeMessage, inspectWorkingTree } from "../../infrastructure/git-working-tree";
import { ScriptSelfUpdater } from "../monitoring/infrastructure/script-self-updater";
import { FileSelfUpdateJobRepository } from "../monitoring/infrastructure/file-self-update-job.repository";
import { DeployQueueService } from "../projects/infrastructure/deploy-queue.service";

const mockedSpawn = spawn as unknown as jest.Mock;

/**
 * Proteções de rollout (Wave 2.5) no lado da API.
 *
 * Foco:
 * - o self-update ABORTA com working tree sujo (sem descartar nada);
 * - o self-update ABORTA se houver deploy de projeto em andamento;
 * - o worker de deploy entra em DRAINING (nenhum deploy começa durante o
 *   update) e o drain sobrevive a um restart (via arquivo);
 * - o drain expira sozinho (não trava os deploys para sempre);
 * - jobs antigos continuam pausados depois do restart.
 */
describe("rollout - proteções na API", () => {
  let repoDir: string;
  let stateDir: string;
  let previousRepoDir: string | undefined;
  let previousStateDir: string | undefined;

  function git(args: string[], cwd = repoDir): string {
    return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
  }

  function initRepo(): void {
    git(["init", "-b", "main"]);
    git(["config", "user.email", "teste@korrelo.local"]);
    git(["config", "user.name", "Teste Korrelo"]);
    fs.writeFileSync(path.join(repoDir, "arquivo.txt"), "conteudo\n");
    git(["add", "."]);
    git(["commit", "-m", "inicial"]);
  }

  beforeEach(() => {
    mockedSpawn.mockReset();
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-repo-"));
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-state-"));
    previousRepoDir = process.env.KORRELO_REPO_DIR;
    previousStateDir = process.env.KORRELO_STATE_DIR;
    process.env.KORRELO_REPO_DIR = repoDir;
    process.env.KORRELO_STATE_DIR = stateDir;
    initRepo();
  });

  afterEach(() => {
    if (previousRepoDir === undefined) delete process.env.KORRELO_REPO_DIR;
    else process.env.KORRELO_REPO_DIR = previousRepoDir;
    if (previousStateDir === undefined) delete process.env.KORRELO_STATE_DIR;
    else process.env.KORRELO_STATE_DIR = previousStateDir;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function fakeQueue(options: { activeJob?: boolean; drained?: string[] } = {}) {
    return {
      hasActiveJob: async () => options.activeJob === true,
      drain: async (reason: string) => {
        options.drained?.push(reason);
      },
      releaseDrain: async () => undefined,
      isDraining: () => false,
    } as unknown as DeployQueueService;
  }

  function makeUpdater(queue: DeployQueueService): ScriptSelfUpdater {
    return new ScriptSelfUpdater(queue, new FileSelfUpdateJobRepository());
  }

  it("detecta working tree sujo e monta a mensagem padronizada", async () => {
    // Caso real da VPS: package-lock.json EXISTE e foi modificado.
    fs.writeFileSync(path.join(repoDir, "package-lock.json"), "{}\n");
    git(["add", "."]);
    git(["commit", "-m", "lockfile"]);
    fs.writeFileSync(path.join(repoDir, "package-lock.json"), '{ "muda": true }\n');

    const state = await inspectWorkingTree(repoDir);
    const message = formatDirtyWorkingTreeMessage(state);

    expect(state.clean).toBe(false);
    expect(state.modified).toContain("package-lock.json");
    expect(message).toContain("Working tree contains local changes:");
    expect(message).toContain(" package-lock.json");
    expect(message).toContain("Update aborted. Review or stash/restore explicitly.");
  });

  it("working tree limpo é reconhecido", async () => {
    const state = await inspectWorkingTree(repoDir);
    expect(state.clean).toBe(true);
    expect(state.branch).toBe("main");
  });

  it("o self-update ABORTA com working tree sujo (e não executa nada)", async () => {
    fs.writeFileSync(path.join(repoDir, "package-lock.json"), "{}\n");
    git(["add", "."]);
    git(["commit", "-m", "lockfile"]);
    fs.writeFileSync(path.join(repoDir, "package-lock.json"), '{ "muda": true }\n');
    const drained: string[] = [];
    const updater = makeUpdater(fakeQueue({ drained }));

    await expect(updater.start()).rejects.toThrow(/Working tree contains local changes/);
    // Nada foi executado e o worker nem entrou em drain.
    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(drained).toEqual([]);
  });

  it("o self-update ABORTA quando existe deploy de projeto em andamento", async () => {
    const drained: string[] = [];
    const updater = makeUpdater(fakeQueue({ activeJob: true, drained }));

    await expect(updater.start()).rejects.toThrow(/deploy de projeto em andamento/);
    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(drained).toEqual([]);
  });

  it("com tudo livre, o self-update drena o worker e dispara o runner DETACHED", async () => {
    const drained: string[] = [];
    const updater = makeUpdater(fakeQueue({ drained }));

    mockedSpawn.mockImplementation(() => ({ unref: () => undefined, pid: 1234 }) as never);

    const result = await updater.start();

    expect(result.alreadyRunning).toBe(false);
    expect(result.jobId).toBeTruthy();
    expect(drained).toHaveLength(1);
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockedSpawn.mock.calls[0];
    // Wave 3: quem é disparado é o LAUNCHER detached (double fork) - não o
    // rollout direto (que morria junto com a API no `pm2 restart`).
    expect(command).toBe(process.execPath);
    expect(String(args[0])).toContain("launch-detached.cjs");
    expect(String(args)).toContain("self-update.sh");
    // E o processo é desacoplado (detached + unref).
    expect((options as { detached?: boolean }).detached).toBe(true);
  });

  it("análise estática: nenhum hook de boot escreve no Docker", () => {
    const srcRoot = path.resolve(__dirname, "..", "..");
    const hookFiles = [
      path.join(srcRoot, "modules", "projects", "infrastructure", "runtime-reconciliation.service.ts"),
      path.join(srcRoot, "modules", "projects", "infrastructure", "staging-cleanup.service.ts"),
      path.join(srcRoot, "modules", "projects", "infrastructure", "deploy-queue.service.ts"),
      path.join(srcRoot, "modules", "projects", "infrastructure", "deploy-recovery.service.ts"),
      path.join(srcRoot, "modules", "monitoring", "infrastructure", "os-system-metrics-collector.ts"),
    ];

    const forbidden = [
      "docker rm",
      "docker rmi",
      "docker stop",
      "docker start",
      "docker restart",
      "docker kill",
      "docker update",
      "docker run",
      "docker create",
      "compose up",
      "compose down",
      "compose rm",
    ];

    for (const file of hookFiles) {
      const content = fs.readFileSync(file, "utf-8");
      // O serviço de staging TEM um método de limpeza EXPLÍCITO (que pode
      // remover container de teste) - o que não pode é o boot. Por isso o
      // recorte é só o método onModuleInit.
      const isStagingCleanup = file.endsWith("staging-cleanup.service.ts");
      const region = isStagingCleanup
        ? content.slice(
            content.indexOf("async onModuleInit"),
            content.indexOf("async detectStagingContainers"),
          )
        : content;

      for (const command of forbidden) {
        expect(region).not.toContain(command);
      }
      // E nenhum comando destrutivo é montado por concatenação de string.
      if (isStagingCleanup) {
        expect(region).not.toContain('"rm"');
        expect(region).not.toContain("'rm'");
      }
    }
  });
});
