import { Injectable } from "@nestjs/common";
import * as http from "node:http";
import type { HealthChecker, HealthCheckOptions } from "../domain/health-checker";

const POLL_INTERVAL_MS = 1000;
const REQUEST_TIMEOUT_MS = 1500;

/**
 * Um simples TCP connect não basta: no Docker Desktop (Windows/WSL2), o proxy de
 * porta publicada aceita a conexão mesmo com o processo do container já morto
 * (crash loop), e só derruba a conexão na hora de repassar pro backend. Por isso
 * exigimos uma resposta HTTP de verdade.
 *
 * COMPATIBILIDADE: sem `require2xx`, qualquer resposta HTTP aprova (contrato
 * histórico). Com `require2xx` (readiness configurado no projeto), apenas 2xx
 * aprova - 5xx como 503 de Mongo indisponível REPROVA a etapa.
 */
function checkOnce(port: number, options: HealthCheckOptions): Promise<boolean> {
  const path = options.path && options.path.startsWith("/") ? options.path : "/";
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path, timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        res.resume();
        if (!options.require2xx) {
          resolve(true);
          return;
        }
        resolve(isHealthyResponse(res.statusCode, true));
      },
    );
    req.once("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.once("error", () => resolve(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class HttpHealthChecker implements HealthChecker {
  async waitUntilHealthy(
    port: number,
    timeoutMs: number,
    options: HealthCheckOptions = {},
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (await checkOnce(port, options)) {
        return true;
      }
      await sleep(POLL_INTERVAL_MS);
    }

    return false;
  }
}

/** Exportado para testes de contrato (2xx x qualquer status). */
export function isHealthyResponse(status: number | undefined, require2xx: boolean): boolean {
  if (!require2xx) return true;
  return typeof status === "number" && status >= 200 && status < 300;
}
