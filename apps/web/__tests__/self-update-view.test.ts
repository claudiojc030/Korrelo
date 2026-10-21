/**
 * OBSERVABILIDADE DO SELF-UPDATE (view).
 *
 * Testa a lógica pura do painel: o que o operador vê durante o update.
 *
 * O caso real que motivou isto: o rollout estava em "build-shared", o
 * resource guard aguardava swap/load normalizarem e a UI parecia TRAVADA.
 * O operador não sabia se estava travado ou apenas aguardando.
 */

import {
  decideNextPoll,
  decidePhase,
  detectWaitingFromLog,
  formatElapsed,
  isActiveStatus,
  isTerminalStatus,
  monotonicPercent,
  pickRelevantLogLines,
  sanitizeLogLine,
  stageLabelKey,
  STAGE_LABEL_KEYS,
} from "../lib/self-update-view";

/** Log real do resource guard durante uma espera. */
const WAITING_LOG = [
  "[rollout] preflight: ok",
  "[rollout] build-shared: aguardando recursos",
  "swap em uso=601 MB (limite 512)",
  "load average (1min)=3.19 (limite 1.5)",
  "tentativa=1",
  "próxima checagem em 10s",
  "[rollout] build-shared: aguardando recursos",
  "swap em uso=640 MB (limite 512)",
  "tentativa=2",
  "próxima checagem em 10s",
].join("\n");

const NORMALIZED_LOG = [
  WAITING_LOG,
  "[rollout] build-shared: recursos normalizados após 20s",
  "load1=0.13 (limite 1.5)",
].join("\n");

describe("self-update view - etapa atual", () => {
  it("mapeia os stages do rollout para nomes amigáveis", () => {
    expect(stageLabelKey("preflight")).toBe("updateStagePreflight");
    expect(stageLabelKey("worker-drain")).toBe("updateStageWorkerDrain");
    expect(stageLabelKey("build-shared")).toBe("updateStageBuildShared");
    expect(stageLabelKey("pm2-restart")).toBe("updateStagePm2Restart");
    expect(stageLabelKey("compare-projects")).toBe("updateStageCompareProjects");
    expect(stageLabelKey("complete")).toBe("updateStageComplete");
  });

  it("todos os stages pedidos na wave estão mapeados", () => {
    const esperados = [
      "preflight",
      "lock",
      "worker-drain",
      "snapshot-before",
      "core-backup",
      "git-update",
      "install",
      "build-shared",
      "build-api",
      "build-web",
      "migration",
      "pm2-restart",
      "health-core",
      "snapshot-after",
      "compare-projects",
      "complete",
    ];
    for (const stage of esperados) {
      expect(STAGE_LABEL_KEYS[stage]).toBeDefined();
    }
  });

  it("stage desconhecido devolve null (a UI mostra o id cru, não inventa)", () => {
    expect(stageLabelKey("stage-que-nao-existe")).toBeNull();
    expect(stageLabelKey(null)).toBeNull();
    expect(stageLabelKey(undefined)).toBeNull();
  });
});

describe("self-update view - tempo decorrido", () => {
  const inicio = "2026-10-20T12:00:00.000Z";

  it("calcula o tempo decorrido a partir do startedAt", () => {
    // 2m 14s depois.
    const now = Date.parse(inicio) + (2 * 60 + 14) * 1000;
    expect(formatElapsed(inicio, now)).toBe("2m 14s");
  });

  it("formata segundos, minutos e horas", () => {
    const base = Date.parse(inicio);
    expect(formatElapsed(inicio, base + 5_000)).toBe("5s");
    expect(formatElapsed(inicio, base + 65_000)).toBe("1m 5s");
    expect(formatElapsed(inicio, base + 3_600_000)).toBe("1h 0m 0s");
  });

  it("sem startedAt (ou data inválida) não inventa tempo", () => {
    expect(formatElapsed(null)).toBe("");
    expect(formatElapsed(undefined)).toBe("");
    expect(formatElapsed("data-invalida")).toBe("");
  });

  it("clock atrás do startedAt não fica negativo", () => {
    expect(formatElapsed(inicio, Date.parse(inicio) - 10_000)).toBe("0s");
  });
});

describe("self-update view - progresso não regride", () => {
  it("mantém o maior percentual já visto", () => {
    expect(monotonicPercent(0, 40)).toBe(40);
    // O executor emite um step fora de ordem numérica: a barra não volta.
    expect(monotonicPercent(70, 40)).toBe(70);
    expect(monotonicPercent(70, 99)).toBe(99);
  });

  it("ignora valores inválidos e limita a 0-100", () => {
    expect(monotonicPercent(55, Number.NaN)).toBe(55);
    expect(monotonicPercent(55, -10)).toBe(55);
    expect(monotonicPercent(0, 150)).toBe(100);
  });
});

describe("self-update view - espera por recursos", () => {
  it("detecta a espera por recursos no log", () => {
    expect(detectWaitingFromLog(WAITING_LOG)).toBe(true);
  });

  it("volta para 'não esperando' quando os recursos normalizam", () => {
    expect(detectWaitingFromLog(NORMALIZED_LOG)).toBe(false);
  });

  it("volta para 'não esperando' quando um novo stage começa", () => {
    const comNovoStage = [
      WAITING_LOG,
      "__KORRELO_UPDATE_STEP__|40|build-shared",
      "[rollout] build-shared: compilando",
    ].join("\n");
    expect(detectWaitingFromLog(comNovoStage)).toBe(false);
  });

  it("sem espera no log, não está esperando", () => {
    expect(detectWaitingFromLog("")).toBe(false);
    expect(detectWaitingFromLog("[rollout] preflight: ok")).toBe(false);
  });
});

describe("self-update view - fases", () => {
  it("RUNNING quando o job está em andamento", () => {
    expect(decidePhase({ done: false, success: null, waiting: false })).toBe("running");
  });

  it("WAITING quando o executor aguarda recursos", () => {
    expect(decidePhase({ done: false, success: null, waiting: true })).toBe("waiting");
  });

  it("SUCCESS quando o job terminou com sucesso", () => {
    expect(decidePhase({ done: true, success: true })).toBe("success");
  });

  it("FAILED quando o job terminou com falha", () => {
    expect(decidePhase({ done: true, success: false })).toBe("failed");
  });

  it("INTERRUPTED tem prioridade sobre os demais", () => {
    expect(decidePhase({ done: true, success: null, interrupted: true })).toBe("interrupted");
  });

  it("RECONNECTING quando a API não responde", () => {
    expect(decidePhase({ done: false, success: null, reconnecting: true })).toBe("reconnecting");
  });
});

describe("self-update view - o polling continua enquanto o job roda", () => {
  // Este é o comportamento que fazia a UI parecer TRAVADA: o modal antigo
  // só re-agendava a consulta nos caminhos de ERRO - no caminho normal o
  // polling terminava na primeira leitura e a tela ficava congelada.
  it("com o job em andamento, consulta de novo", () => {
    expect(decideNextPoll({ done: false, success: null })).toBe("poll-again");
  });

  it("com o job terminado com sucesso, espera a API voltar", () => {
    expect(decideNextPoll({ done: true, success: true })).toBe("wait-health");
  });

  it("com o job terminado com falha, para de consultar", () => {
    expect(decideNextPoll({ done: true, success: false })).toBe("stop");
  });

  it("com o job interrompido, para de consultar", () => {
    expect(decideNextPoll({ done: false, success: null, interrupted: true })).toBe("stop");
  });
});

describe("self-update view - status do job", () => {
  it("um job ativo é reaberto (não fica preso em 'Atualizando')", () => {
    expect(isActiveStatus("queued")).toBe(true);
    expect(isActiveStatus("running")).toBe(true);
    expect(isActiveStatus("restarting")).toBe(true);
    expect(isActiveStatus("verifying")).toBe(true);
  });

  it("um job terminado é terminal", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("interrupted")).toBe(true);
    expect(isTerminalStatus("running")).toBe(false);
    expect(isTerminalStatus(null)).toBe(false);
  });
});

describe("self-update view - atividade recente", () => {
  it("mostra as linhas relevantes (rollout, espera, health, erro)", () => {
    const linhas = pickRelevantLogLines(WAITING_LOG);
    expect(linhas.length).toBeGreaterThan(0);
    expect(linhas.join("\n")).toContain("aguardando recursos");
    expect(linhas.join("\n")).toContain("swap em uso=601 MB (limite 512)");
  });

  it("limita a ~20 linhas", () => {
    const log = Array.from({ length: 200 }, (_, i) => `[rollout] build-shared: passo ${i}`).join("\n");
    expect(pickRelevantLogLines(log, 20)).toHaveLength(20);
  });

  it("descarta ruído de build (o operador quer o que está acontecendo)", () => {
    const log = [
      "[rollout] install: ok",
      "> korrelo@0.1.0 build",
      "> tsc -p tsconfig.json",
      "src/arquivo.ts(12,5): error TS2345",
      "[rollout] build-shared: compilando",
    ].join("\n");
    const linhas = pickRelevantLogLines(log);
    expect(linhas.join("\n")).toContain("install: ok");
    expect(linhas.join("\n")).not.toContain("tsc -p tsconfig.json");
  });

  it("não mostra os marcadores internos (protocolo runner <-> API)", () => {
    const log = [
      "__KORRELO_UPDATE_STEP__|40|build-shared",
      "__KORRELO_UPDATE_META__|executorCommit|abc123",
      "[rollout] build-shared: compilando",
    ].join("\n");
    const linhas = pickRelevantLogLines(log);
    expect(linhas.join("\n")).not.toContain("__KORRELO_UPDATE_");
    expect(linhas.join("\n")).toContain("build-shared: compilando");
  });

  it("se não houver linha relevante, mostra as últimas linhas mesmo assim", () => {
    const log = "linha 1\nlinha 2\nlinha 3";
    const linhas = pickRelevantLogLines(log, 20);
    expect(linhas).toEqual(["linha 1", "linha 2", "linha 3"]);
  });
});

describe("self-update view - segredos nunca aparecem", () => {
  it("remove senha/token/chave de uma linha", () => {
    expect(sanitizeLogLine("JWT_SECRET=abc123def456")).not.toContain("abc123def456");
    expect(sanitizeLogLine("DATABASE_PASSWORD=supersecret")).not.toContain("supersecret");
    expect(sanitizeLogLine("API_KEY: xyz987")).not.toContain("xyz987");
  });

  it("remove connection string com credencial", () => {
    const linha = "conectando em mongodb://user:senha123@host:27017/db";
    const limpo = sanitizeLogLine(linha);
    expect(limpo).not.toContain("senha123");
  });

  it("remove bearer token e chave privada PEM", () => {
    expect(sanitizeLogLine("Authorization: Bearer abcdef.123456")).not.toContain("abcdef.123456");
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----";
    expect(sanitizeLogLine(pem)).not.toContain("MIIEow");
  });

  it("a atividade recente não carrega segredo", () => {
    const log = [
      "[rollout] install: ok",
      "JWT_SECRET=abc123def456",
      "DB_PASSWORD=supersecret",
    ].join("\n");
    const linhas = pickRelevantLogLines(log);
    expect(linhas.join("\n")).not.toContain("abc123def456");
    expect(linhas.join("\n")).not.toContain("supersecret");
  });

  it("não quebra linha normal sem segredo", () => {
    expect(sanitizeLogLine("[rollout] build-shared: compilando")).toBe(
      "[rollout] build-shared: compilando",
    );
  });
});
