/**
 * OBSERVABILIDADE DO SELF-UPDATE (backend).
 *
 * O caso real: o rollout estava em "build-shared", o resource guard
 * aguardava swap/load normalizarem e a UI parecia TRAVADA. O operador não
 * sabia se estava travado ou apenas aguardando.
 *
 * Aqui provamos que o backend consegue distinguir as duas coisas - SEM
 * alterar o executor: a leitura é do log que o runner JÁ grava.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileSelfUpdateJobRepository } from "../infrastructure/file-self-update-job.repository";
import { ScriptSelfUpdater, detectResourceWait } from "../infrastructure/script-self-updater";
import type { SelfUpdateJob } from "../domain/self-update-job.entity";

/** Log real do resource guard durante uma espera (formato do resource-guard.cjs). */
const AGUARDANDO_LOG = [
  "[rollout] preflight: ok",
  "[rollout] build-shared: aguardando recursos",
  "swap em uso=601 MB (limite 512)",
  "load average (1min)=3.19 (limite 1.5)",
  "tentativa=1",
  "próxima checagem em 10s",
].join("\n");

const NORMALIZADO_LOG = [
  AGUARDANDO_LOG,
  "[rollout] build-shared: recursos normalizados após 20s",
  "load1=0.13 (limite 1.5)",
].join("\n");

describe("self-update - inferência da espera por recursos", () => {
  it("1) detecta a espera e traz os detalhes medidos pelo executor", () => {
    const wait = detectResourceWait(AGUARDANDO_LOG);

    expect(wait.waiting).toBe(true);
    // Os números são os que o executor mediu - nada é inventado.
    expect(wait.details).toEqual([
      "swap em uso=601 MB (limite 512)",
      "load average (1min)=3.19 (limite 1.5)",
    ]);
    expect(wait.nextRetryInSeconds).toBe(10);
    expect(wait.attempt).toBe(1);
  });

  it("2) volta a 'executando' quando os recursos normalizam", () => {
    const wait = detectResourceWait(NORMALIZADO_LOG);

    expect(wait.waiting).toBe(false);
    expect(wait.details).toBeNull();
  });

  it("3) volta a 'executando' quando um novo stage começa", () => {
    const log = [
      AGUARDANDO_LOG,
      "__KORRELO_UPDATE_STEP__|40|build-shared",
      "[rollout] build-shared: compilando",
    ].join("\n");

    expect(detectResourceWait(log).waiting).toBe(false);
  });

  it("4) sem espera no log, não está esperando", () => {
    expect(detectResourceWait("").waiting).toBe(false);
    expect(detectResourceWait("[rollout] preflight: ok").waiting).toBe(false);
  });

  it("5) a última espera vence (a mais recente é a que vale)", () => {
    const log = [
      "[rollout] build-api: aguardando recursos",
      "tentativa=1",
      "[rollout] build-api: recursos normalizados após 10s",
      "[rollout] build-web: aguardando recursos",
      "swap em uso=700 MB (limite 512)",
      "tentativa=3",
      "próxima checagem em 10s",
    ].join("\n");

    const wait = detectResourceWait(log);
    expect(wait.waiting).toBe(true);
    expect(wait.attempt).toBe(3);
    expect(wait.details).toEqual(["swap em uso=700 MB (limite 512)"]);
  });
});

describe("self-update - o status expõe a observabilidade", () => {
  let dir: string;
  let repo: FileSelfUpdateJobRepository;
  let updater: ScriptSelfUpdater;

  const fakeQueue = () =>
    ({
      hasActiveJob: async () => false,
      drain: async () => undefined,
    }) as never;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-update-status-"));
    process.env.KORRELO_SELF_UPDATE_DIR = dir;
    repo = new FileSelfUpdateJobRepository();
    updater = new ScriptSelfUpdater(fakeQueue(), repo);
  });

  afterEach(() => {
    delete process.env.KORRELO_SELF_UPDATE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeJob(overrides: Partial<SelfUpdateJob> = {}): SelfUpdateJob {
    return {
      id: "upd-1",
      startedAt: "2026-10-20T12:00:00.000Z",
      finishedAt: null,
      status: "running",
      executorCommit: null,
      previousCommit: "aaaa1111",
      candidateCommit: "bbbb2222",
      previousBranch: "main",
      currentStage: "build-shared",
      progress: 40,
      pid: process.pid, // runner "vivo"
      result: null,
      failureReason: null,
      recoveryStatus: null,
      lastMessage: "stage: build-shared",
      ...overrides,
    };
  }

  async function writeLog(content: string): Promise<void> {
    fs.writeFileSync(repo.logPath("upd-1"), content, "utf-8");
  }

  it("6) job em andamento: mostra etapa, progresso persistido e tempo de início", async () => {
    await repo.save(makeJob());
    await writeLog("[rollout] build-shared: compilando\n");

    const status = await updater.getStatus();

    expect(status.running).toBe(true);
    expect(status.done).toBe(false);
    expect(status.currentStage).toBe("build-shared");
    // O progresso vem do JOB PERSISTIDO (o runner é quem o atualiza).
    expect(status.progress).toBe(40);
    expect(status.percent).toBe(40);
    expect(status.startedAt).toBe("2026-10-20T12:00:00.000Z");
    expect(status.waiting).toBe(false);
  });

  it("7) job aguardando recursos: o status diz WAITING com os detalhes", async () => {
    await repo.save(makeJob());
    await writeLog(AGUARDANDO_LOG);

    const status = await updater.getStatus();

    expect(status.waiting).toBe(true);
    expect(status.waitingDetails).toEqual([
      "swap em uso=601 MB (limite 512)",
      "load average (1min)=3.19 (limite 1.5)",
    ]);
    expect(status.nextRetryInSeconds).toBe(10);
  });

  it("8) depois da normalização, volta para RUNNING", async () => {
    await repo.save(makeJob());
    await writeLog(NORMALIZADO_LOG);

    const status = await updater.getStatus();

    expect(status.waiting).toBe(false);
    expect(status.waitingDetails).toBeNull();
  });

  it("9) job concluído com sucesso: done=true, success=true, 100%", async () => {
    await repo.save(
      makeJob({
        status: "completed",
        progress: 100,
        currentStage: "complete",
        finishedAt: "2026-10-20T12:05:00.000Z",
        result: "success",
      }),
    );
    await writeLog(
      [
        "__KORRELO_UPDATE_STEP__|100|complete",
        "__KORRELO_UPDATE_DONE__|success|",
        "[rollout] complete: ok",
      ].join("\n"),
    );

    const status = await updater.getStatus();

    expect(status.done).toBe(true);
    expect(status.success).toBe(true);
    expect(status.percent).toBe(100);
    expect(status.finishedAt).toBe("2026-10-20T12:05:00.000Z");
  });

  it("10) job com falha: done=true, success=false e o motivo", async () => {
    await repo.save(
      makeJob({
        status: "failed",
        result: "failed",
        failureReason: "falha no build da API",
      }),
    );
    await writeLog(
      [
        "__KORRELO_UPDATE_STEP__|55|build-api",
        "__KORRELO_UPDATE_DONE__|failed|falha no build da API",
      ].join("\n"),
    );

    const status = await updater.getStatus();

    expect(status.done).toBe(true);
    expect(status.success).toBe(false);
    expect(status.errorMessage).toContain("falha no build da API");
  });

  it("11) o log do status é sanitizado (o segredo não sai da API)", async () => {
    await repo.save(makeJob());
    await writeLog(AGUARDANDO_LOG);

    const status = await updater.getStatus();

    // A linha útil continua lá - só o que parece segredo é removido.
    expect(status.log).toContain("aguardando recursos");
    expect(status.log).toContain("swap em uso=601 MB (limite 512)");
  });
});

describe("self-update - o segredo é removido NO BACKEND", () => {
  let dir: string;
  let repo: FileSelfUpdateJobRepository;
  let updater: ScriptSelfUpdater;

  const fakeQueue = () =>
    ({
      hasActiveJob: async () => false,
      drain: async () => undefined,
    }) as never;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-update-secret-"));
    process.env.KORRELO_SELF_UPDATE_DIR = dir;
    repo = new FileSelfUpdateJobRepository();
    updater = new ScriptSelfUpdater(fakeQueue(), repo);
  });

  afterEach(() => {
    delete process.env.KORRELO_SELF_UPDATE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("o log do status não carrega segredo de env", async () => {
    process.env.KORRELO_TEST_SECRET_VALUE = "valor-secreto-123456";
    try {
      await repo.save({
        id: "upd-1",
        startedAt: "2026-10-20T12:00:00.000Z",
        finishedAt: null,
        status: "running",
        executorCommit: null,
        previousCommit: null,
        candidateCommit: null,
        previousBranch: null,
        currentStage: "install",
        progress: 30,
        pid: process.pid,
        result: null,
        failureReason: null,
        recoveryStatus: null,
        lastMessage: null,
      });
      fs.writeFileSync(
        repo.logPath("upd-1"),
        [
          "[rollout] install: ok",
          "usando o token valor-secreto-123456 no registry",
        ].join("\n"),
        "utf-8",
      );

      const status = await updater.getStatus();

      expect(status.log).not.toContain("valor-secreto-123456");
      // A linha útil continua lá.
      expect(status.log).toContain("[rollout] install: ok");
    } finally {
      delete process.env.KORRELO_TEST_SECRET_VALUE;
    }
  });

  it("o log do endpoint /self-update/:id/log também vem limpo", async () => {
    fs.writeFileSync(
      repo.logPath("upd-2"),
      ["JWT_SECRET=abc123def456", "[rollout] preflight: ok"].join("\n"),
      "utf-8",
    );

    const log = await updater.getJobLog("upd-2");

    expect(log).not.toContain("abc123def456");
    expect(log).toContain("[rollout] preflight: ok");
  });

  it("remove bearer token, connection string e chave privada PEM", async () => {
    fs.writeFileSync(
      repo.logPath("upd-3"),
      [
        "Authorization: Bearer abcdef.123456",
        "conectando em mongodb://user:senha123@host:27017/db",
        "-----BEGIN RSA PRIVATE KEY-----",
        "MIIEowIBAAKCAQEA",
        "-----END RSA PRIVATE KEY-----",
      ].join("\n"),
      "utf-8",
    );

    const log = await updater.getJobLog("upd-3");

    expect(log).not.toContain("abcdef.123456");
    expect(log).not.toContain("senha123");
    expect(log).not.toContain("MIIEowIBAAKCAQEA");
  });

  it("o motivo de falha também é sanitizado", async () => {
    await repo.save({
      id: "upd-4",
      startedAt: "2026-10-20T12:00:00.000Z",
      finishedAt: "2026-10-20T12:01:00.000Z",
      status: "failed",
      executorCommit: null,
      previousCommit: null,
      candidateCommit: null,
      previousBranch: null,
      currentStage: "install",
      progress: 30,
      pid: null,
      result: "failed",
      failureReason: "falha ao usar API_KEY=chavesecreta123",
      recoveryStatus: null,
      lastMessage: null,
    });
    fs.writeFileSync(
      repo.logPath("upd-4"),
      ["__KORRELO_UPDATE_DONE__|failed|falha ao usar API_KEY=chavesecreta123"].join("\n"),
      "utf-8",
    );

    const status = await updater.getStatus();

    expect(status.errorMessage).not.toContain("chavesecreta123");
  });
});
