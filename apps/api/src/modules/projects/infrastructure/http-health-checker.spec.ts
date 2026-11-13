import * as http from "node:http";
import { AddressInfo } from "node:net";
import { HttpHealthChecker, isHealthyResponse } from "./http-health-checker";

/**
 * CONTRATO DE SAÚDE (incidente Mesatta).
 *
 * - Default histórico: qualquer resposta HTTP em "/" aprova (compatibilidade).
 * - Com readiness configurado: SOMENTE 2xx aprova; 503/500 reprovam.
 */
describe("HttpHealthChecker", () => {
  const checker = new HttpHealthChecker();
  let server: http.Server;
  let port: number;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  beforeAll(async () => {
    server = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("isHealthyResponse: default aceita qualquer status; readiness exige 2xx", () => {
    expect(isHealthyResponse(500, false)).toBe(true);
    expect(isHealthyResponse(503, false)).toBe(true);
    expect(isHealthyResponse(200, true)).toBe(true);
    expect(isHealthyResponse(204, true)).toBe(true);
    expect(isHealthyResponse(500, true)).toBe(false);
    expect(isHealthyResponse(503, true)).toBe(false);
    expect(isHealthyResponse(undefined, true)).toBe(false);
  });

  it("readiness 503 NÃO aprova o staging", async () => {
    handler = (_req, res) => {
      res.statusCode = 503;
      res.end("mongo unavailable");
    };
    const ok = await checker.waitUntilHealthy(port, 1200, {
      path: "/health/ready",
      require2xx: true,
    });
    expect(ok).toBe(false);
  });

  it("readiness 500 NÃO aprova a produção", async () => {
    handler = (_req, res) => {
      res.statusCode = 500;
      res.end("error");
    };
    const ok = await checker.waitUntilHealthy(port, 1200, {
      path: "/health/ready",
      require2xx: true,
    });
    expect(ok).toBe(false);
  });

  it("responde 200 apenas no caminho configurado", async () => {
    handler = (req, res) => {
      res.statusCode = req.url === "/health/ready" ? 200 : 503;
      res.end();
    };
    await expect(
      checker.waitUntilHealthy(port, 2000, { path: "/health/ready", require2xx: true }),
    ).resolves.toBe(true);
  });

  it("projeto sem readiness mantém compatibilidade (500 continua 'vivo')", async () => {
    handler = (_req, res) => {
      res.statusCode = 500;
      res.end();
    };
    await expect(checker.waitUntilHealthy(port, 1200)).resolves.toBe(true);
  });

  it("resposta atrasada é aprovada quando chega dentro do timeout", async () => {
    // Teste proporcional: 1,2s de atraso com timeout de 5s cobre a mesma
    // lógica usada para 45s/120s (o valor real é validado na config).
    handler = (_req, res) => {
      setTimeout(() => {
        res.statusCode = 200;
        res.end();
      }, 1200);
    };
    await expect(
      checker.waitUntilHealthy(port, 5000, { path: "/health/ready", require2xx: true }),
    ).resolves.toBe(true);
  });
});
