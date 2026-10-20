/**
 * PERSISTÊNCIA DO JOB DE SELF-UPDATE (runner como dono da atualização).
 *
 * Incidente real: o rollout terminou com sucesso (os marcadores STEP/DONE
 * estavam no log), mas o JSON do job ficou em status "running" / 0% - a UI
 * permaneceu travada em 0%.
 *
 * Causa: quem emitia os marcadores era o rollout, mas QUEM PERSISTIA o
 * estado era só a API - e a API reinicia no meio do update (é o próprio
 * update que reinicia a API). O job nunca era gravado durante a execução.
 *
 * Agora o RUNNER é o dono: o rollout aplica cada marcador no JSON do job
 * (escrita atômica) e finaliza o job - inclusive quando morre sem marcador
 * final.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodePath = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeFs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeOs = require("node:os");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { spawn } = require("node:child_process");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const LIBS = nodePath.resolve(__dirname, "..", "..", "..", "..", "scripts", "rollout", "lib");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jobLib = require(nodePath.join(LIBS, "self-update-job.cjs"));

type Job = Record<string, unknown>;

describe("self-update - o runner persiste progresso e resultado", () => {
  let tmpDir: string;
  let jobFile: string;

  beforeEach(() => {
    tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "korrelo-job-"));
    jobFile = nodePath.join(tmpDir, "upd-1.json");
    jobLib.writeJob(jobFile, {
      id: "upd-1",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: "running",
      executorCommit: null,
      previousCommit: null,
      candidateCommit: null,
      previousBranch: null,
      currentStage: null,
      progress: 0,
      pid: null,
      result: null,
      failureReason: null,
      recoveryStatus: null,
      lastMessage: null,
    });
  });

  afterEach(() => {
    nodeFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function read(): Job {
    return JSON.parse(nodeFs.readFileSync(jobFile, "utf-8")) as Job;
  }

  it("1) um marcador STEP atualiza o JSON (progresso e stage)", () => {
    jobLib.applyMarker(jobFile, jobLib.parseMarker("__KORRELO_UPDATE_STEP__|40|build-shared"));

    const job = read();
    expect(job.progress).toBe(40);
    expect(job.currentStage).toBe("build-shared");
    expect(job.status).toBe("running");
    expect(job.updatedAt).toBeTruthy();
  });

  it("2) múltiplos STEP: o estado avança corretamente", () => {
    for (const [percent, stage] of [
      [2, "preflight"],
      [20, "lock"],
      [55, "build-api"],
      [93, "pm2-restart"],
      [100, "complete"],
    ]) {
      jobLib.applyMarker(jobFile, jobLib.parseMarker(`__KORRELO_UPDATE_STEP__|${percent}|${stage}`));
    }

    const job = read();
    expect(job.progress).toBe(100);
    expect(job.currentStage).toBe("complete");
  });

  it("3) DONE success finaliza o job", () => {
    jobLib.applyMarker(jobFile, jobLib.parseMarker("__KORRELO_UPDATE_STEP__|100|complete"));
    jobLib.applyMarker(jobFile, jobLib.parseMarker("__KORRELO_UPDATE_DONE__|success|"));

    const job = read();
    expect(job.status).toBe("completed");
    expect(job.progress).toBe(100);
    expect(job.currentStage).toBe("complete");
    expect(job.finishedAt).toBeTruthy();
    expect(job.result).toBe("success");
    expect(job.failureReason).toBeNull();
  });

  it("4) DONE failed registra o motivo (sanitizado)", () => {
    // O valor sensível vem do ambiente (é assim que um segredo escaparia
    // para o log/job).
    const previous = process.env.API_TOKEN;
    process.env.API_TOKEN = "super-secreto-123456";
    try {
      jobLib.applyMarker(
        jobFile,
        jobLib.parseMarker("__KORRELO_UPDATE_DONE__|failed|falhou: token super-secreto-123456"),
      );
    } finally {
      if (previous === undefined) delete process.env.API_TOKEN;
      else process.env.API_TOKEN = previous;
    }

    const job = read();
    expect(job.status).toBe("failed");
    expect(job.finishedAt).toBeTruthy();
    expect(job.result).toBe("failed");
    expect(String(job.failureReason)).toContain("falhou");
    expect(String(job.failureReason)).not.toContain("super-secreto-123456");
  });

  it("5) exit 0 SEM marcador final: o job não fica running eternamente", () => {
    const finalized = jobLib.finalizeJob(jobFile, { exitCode: 0, reason: null });

    expect(finalized?.status).toBe("failed");
    expect(finalized?.result).toBe("incomplete");
    expect(String(finalized?.failureReason)).toContain("sem marcador final");
    expect(read().finishedAt).toBeTruthy();
  });

  it("6) exit != 0 SEM marcador final: o job vira failed", () => {
    const finalized = jobLib.finalizeJob(jobFile, { exitCode: 1, reason: "processo morto" });

    expect(finalized?.status).toBe("failed");
    expect(finalized?.result).toBe("incomplete");
    expect(String(finalized?.failureReason)).toContain("processo morto");
  });

  it("7) o runner continua e persiste durante o 'restart' da API", async () => {
    // O runner grava o progresso; a "API" (leitor) não existe durante a
    // escrita e volta depois - o estado persistido está correto.
    jobLib.applyMarker(jobFile, jobLib.parseMarker("__KORRELO_UPDATE_STEP__|55|build-api"));
    // (a API estaria fora do ar aqui)

    const job = read();
    expect(job.progress).toBe(55);
    expect(job.currentStage).toBe("build-api");
    expect(job.status).toBe("running");
  });

  it("8) processo REAL: o job é atualizado durante a execução e finalizado no fim", async () => {
    const script = nodePath.join(tmpDir, "runner.js");
    nodeFs.writeFileSync(
      script,
      [
        `const job = require(${JSON.stringify(nodePath.join(LIBS, "self-update-job.cjs"))});`,
        `const file = ${JSON.stringify(jobFile)};`,
        `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));`,
        `(async () => {`,
        `  for (const [percent, stage] of [[2, "preflight"], [40, "build-shared"], [96, "health-core"]]) {`,
        `    job.applyMarker(file, job.parseMarker("__KORRELO_UPDATE_STEP__|" + percent + "|" + stage));`,
        `    await sleep(120);`,
        `  }`,
        `  job.applyMarker(file, job.parseMarker("__KORRELO_UPDATE_DONE__|success|"));`,
        `})();`,
      ].join("\n"),
    );

    const child = spawn(process.execPath, [script], { stdio: "ignore" });

    // Enquanto o runner trabalha, o job já reflete o progresso.
    await new Promise((resolve) => setTimeout(resolve, 160));
    const during = read();
    expect(during.progress).toBeGreaterThan(0);
    expect(during.status).toBe("running");

    await new Promise((resolve) => child.on("exit", resolve));

    const finished = read();
    expect(finished.status).toBe("completed");
    expect(finished.progress).toBe(100);
    expect(finished.result).toBe("success");
    expect(finished.finishedAt).toBeTruthy();
  }, 20000);

  it("9) leitura concorrente: nunca lê um JSON pela metade", async () => {
    let corrupted = 0;
    let reads = 0;
    let stop = false;
    const reader = setInterval(() => {
      reads += 1;
      try {
        const raw = nodeFs.readFileSync(jobFile, "utf-8");
        JSON.parse(raw);
      } catch (error) {
        // Arquivo sumiu (o rename é atômico) não é corrupção; JSON inválido é.
        if (!String((error as Error).message).includes("ENOENT")) corrupted += 1;
      }
    }, 2);

    const writer = setInterval(() => {
      jobLib.applyMarker(jobFile, jobLib.parseMarker("__KORRELO_UPDATE_STEP__|50|build-api"));
    }, 1);

    await new Promise((resolve) => setTimeout(resolve, 400));
    stop = true;
    clearInterval(reader);
    clearInterval(writer);
    void stop;

    expect(reads).toBeGreaterThan(10);
    expect(corrupted).toBe(0);
  }, 20000);

  it("10) job stale (PID morto + status running) é finalizado com segurança", () => {
    jobLib.updateJob(jobFile, { status: "running", pid: 999_999_999 });
    const finalized = jobLib.finalizeJob(jobFile, {
      exitCode: null,
      reason: "o processo do runner não existe mais",
    });

    expect(finalized?.status).toBe("failed");
    expect(finalized?.finishedAt).toBeTruthy();
    expect(String(finalized?.failureReason)).toContain("não existe mais");
  });

  it("11) o marcador META preenche os metadados do job", () => {
    jobLib.applyMarker(jobFile, jobLib.parseMarker("__KORRELO_UPDATE_META__|executorCommit|abc1234"));
    jobLib.applyMarker(jobFile, jobLib.parseMarker("__KORRELO_UPDATE_META__|previousCommit|old9999"));
    jobLib.applyMarker(jobFile, jobLib.parseMarker("__KORRELO_UPDATE_META__|candidateCommit|new7777"));
    jobLib.applyMarker(jobFile, jobLib.parseMarker("__KORRELO_UPDATE_META__|previousBranch|main"));

    const job = read();
    expect(job.executorCommit).toBe("abc1234");
    expect(job.previousCommit).toBe("old9999");
    expect(job.candidateCommit).toBe("new7777");
    expect(job.previousBranch).toBe("main");
  });

  it("12) marcadores desconhecidos são ignorados sem quebrar o job", () => {
    expect(jobLib.parseMarker("__KORRELO_UPDATE_STEP__|abc|build")).toBeNull();
    expect(jobLib.parseMarker("__KORRELO_UPDATE_META__|desconhecido|x")).toBeNull();
    expect(jobLib.parseMarker("linha normal de log")).toBeNull();

    const before = read();
    jobLib.applyMarker(jobFile, null);
    expect(read().progress).toBe(before.progress);
  });
});

export {};
