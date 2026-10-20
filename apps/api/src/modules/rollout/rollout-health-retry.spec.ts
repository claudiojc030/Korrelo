/**
 * HEALTH CHECK DO CORE COM RETRY (depois do restart do PM2).
 *
 * Incidente real: o rollout consultava o health UMA vez logo após
 * `pm2 restart korrelo-api`. Nos primeiros segundos a API ainda não
 * escutava (ECONNREFUSED) e o rollout tratou como falha fatal: rollback
 * desnecessário, restart extra de API/Web e risco operacional. Minutos
 * depois a API estava saudável (HTTP 200) - nunca esteve quebrada.
 *
 * Aqui o health é polled com retry + grace period + timeout total. Os
 * testes usam um SERVIDOR HTTP REAL (porta temporária) para provar o
 * comportamento de verdade.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodePath = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const http = require("node:http");
import type * as HttpTypes from "node:http";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeFs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeOs = require("node:os");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { spawn } = require("node:child_process");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const LIBS = nodePath.resolve(__dirname, "..", "..", "..", "scripts", "rollout", "lib");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const healthLib = require(nodePath.join(LIBS, "health-check.cjs"));

type RunResult = { code: number; stdout: string; stderr: string };

/** Runner que fala com o endpoint de verdade (mesmo contrato do curl). */
async function httpRunner(command: string, args: string[]): Promise<RunResult> {
  if (command !== "curl") return { code: 0, stdout: "", stderr: "" };
  const url = String(args[args.length - 1] ?? "");
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        const status = response.statusCode ?? 500;
        if (status >= 200 && status < 300) {
          resolve({ code: 0, stdout: body, stderr: "" });
          return;
        }
        resolve({ code: 22, stdout: "", stderr: `HTTP ${status}` });
      });
    });
    request.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code ?? "ERR";
      resolve({ code: code === "ECONNREFUSED" ? 7 : 1, stdout: "", stderr: String(error.message) });
    });
    request.setTimeout(5000, () => {
      request.destroy();
      resolve({ code: 28, stdout: "", stderr: "timeout" });
    });
  });
}

/** Sobe um servidor HTTP real numa porta livre. */
function startServer(
  handler: (req: HttpTypes.IncomingMessage, res: HttpTypes.ServerResponse) => void,
): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/health`,
        port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

describe("rollout - health do Core com retry após o restart do PM2", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "korrelo-health-"));
  });

  afterEach(() => {
    nodeFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("1) API sobe imediatamente: a primeira tentativa passa", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    try {
      const result = await healthLib.waitForHealthyEndpoint({
        url: server.url,
        run: httpRunner,
        config: { timeoutSec: 10, intervalSec: 1, initialDelaySec: 0 },
        sleep: async () => undefined,
      });

      expect(result.ok).toBe(true);
      expect(result.attempts).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("2) API demora: ECONNREFUSED, ECONNREFUSED, 200 -> não falha e usa 3 tentativas", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    let attempts = 0;
    const run = async (command: string, args: string[]): Promise<RunResult> => {
      attempts += 1;
      if (attempts < 3) return { code: 7, stdout: "", stderr: "connection refused" };
      return httpRunner(command, args);
    };
    try {
      const result = await healthLib.waitForHealthyEndpoint({
        url: server.url,
        run,
        config: { timeoutSec: 10, intervalSec: 1, initialDelaySec: 0 },
        sleep: async () => undefined,
      });

      expect(result.ok).toBe(true);
      expect(result.attempts).toBe(3);
    } finally {
      await server.close();
    }
  });

  it("3) servidor real com atraso: as primeiras tentativas falham e depois passa", async () => {
    // O endpoint só existe depois de ~250ms (o caso real: o Nest leva
    // alguns segundos para começar a escutar).
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    const url = server.url;
    const startedAt = Date.now();

    // Antes do servidor "subir", o runner simula a conexão recusada.
    const run = async (command: string, args: string[]): Promise<RunResult> => {
      if (Date.now() - startedAt < 250) {
        return { code: 7, stdout: "", stderr: "connection refused" };
      }
      return httpRunner(command, args);
    };

    const result = await healthLib.waitForHealthyEndpoint({
      url,
      run,
      config: { timeoutSec: 5, intervalSec: 1, initialDelaySec: 0 },
      sleep: async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBeGreaterThan(1);
    await server.close();
  });

  it("4) timeout real: o servidor nunca sobe e o polling falha só no fim da janela", async () => {
    const started = Date.now();
    const result = await healthLib.waitForHealthyEndpoint({
      // Porta que ninguém está escutando -> ECONNREFUSED para sempre.
      url: "http://127.0.0.1:1/health",
      run: httpRunner,
      config: { timeoutSec: 2, intervalSec: 1, initialDelaySec: 0 },
      sleep: async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBeGreaterThan(1);
    expect(result.reason).toContain("timeout de 2s");
    expect(result.reason).toContain("conexão recusada");
    // Só falhou DEPOIS da janela (não na primeira tentativa).
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
  });

  it("5) resposta não saudável (503, 503, 200): espera e depois passa", async () => {
    // Servidor real que responde 503 nas duas primeiras chamadas e 200 depois.
    let calls = 0;
    const server = await startServer((_req, res) => {
      calls += 1;
      if (calls < 3) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "starting" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    try {
      const result = await healthLib.waitForHealthyEndpoint({
        url: server.url,
        run: httpRunner,
        config: { timeoutSec: 10, intervalSec: 1, initialDelaySec: 0 },
        sleep: async () => undefined,
      });

      expect(result.ok).toBe(true);
      expect(result.attempts).toBe(3);
    } finally {
      await server.close();
    }
  });

  it("6) a configuração é centralizada e tem limites mínimos", () => {
    const defaults = healthLib.readHealthConfig({});
    expect(defaults.timeoutSec).toBe(60);
    expect(defaults.intervalSec).toBe(2);
    expect(defaults.initialDelaySec).toBe(2);

    // Configurável por env.
    const custom = healthLib.readHealthConfig({
      KORRELO_ROLLOUT_HEALTH_TIMEOUT_SEC: "120",
      KORRELO_ROLLOUT_HEALTH_INTERVAL_SEC: "5",
      KORRELO_ROLLOUT_HEALTH_INITIAL_DELAY_SEC: "10",
    });
    expect(custom.timeoutSec).toBe(120);
    expect(custom.intervalSec).toBe(5);
    expect(custom.initialDelaySec).toBe(10);

    // Limites mínimos razoáveis (timeout curto demais é ignorado).
    const floored = healthLib.readHealthConfig({
      KORRELO_ROLLOUT_HEALTH_TIMEOUT_SEC: "1",
      KORRELO_ROLLOUT_HEALTH_INTERVAL_SEC: "0",
    });
    expect(floored.timeoutSec).toBeGreaterThanOrEqual(10);
    expect(floored.intervalSec).toBeGreaterThanOrEqual(1);
  });

  it("7) o polling mantém o processo Node vivo (timer REFERENCIADO)", async () => {
    // Processo filho real: se o sleep do polling fosse unref'd, o processo
    // terminaria antes (exit 0) e o marcador nunca seria escrito.
    const marker = nodePath.join(tmpDir, "marker.txt");
    const script = nodePath.join(tmpDir, "poller.js");
    nodeFs.writeFileSync(
      script,
      [
        `const health = require(${JSON.stringify(nodePath.join(LIBS, "health-check.cjs"))});`,
        `(async () => {`,
        `  const result = await health.waitForHealthyEndpoint({`,
        `    url: "http://127.0.0.1:1/health",`,
        `    run: async () => ({ code: 7, stdout: "", stderr: "connection refused" }),`,
        `    config: { timeoutSec: 2, intervalSec: 1, initialDelaySec: 0 },`,
        `  });`,
        `  require("node:fs").writeFileSync(${JSON.stringify(marker)}, result.ok ? "ok" : "timeout");`,
        `})();`,
      ].join("\n"),
    );

    const code = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [script], { stdio: "ignore" });
      child.on("exit", (exitCode) => resolve(exitCode ?? -1));
    });

    expect(code).toBe(0);
    // O marcador existe: o processo sobreviveu à janela de espera.
    expect(nodeFs.existsSync(marker)).toBe(true);
    expect(nodeFs.readFileSync(marker, "utf-8")).toBe("timeout");
  }, 20000);

  it("8) o erro reportado é curto e sanitizado (sem stack trace)", () => {
    const message = healthLib.describeFailure(
      { code: 7, stdout: "", stderr: "curl: (7) Failed to connect to 127.0.0.1 port 3001" },
      {},
    );
    expect(message).toContain("curl 7");
    expect(message).toContain("conexão recusada");
    expect(message.length).toBeLessThan(300);
  });
});

export {};
