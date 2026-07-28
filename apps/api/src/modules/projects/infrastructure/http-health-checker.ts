import { Injectable } from "@nestjs/common";
import * as http from "node:http";
import type { HealthChecker } from "../domain/health-checker";

const POLL_INTERVAL_MS = 1000;
const REQUEST_TIMEOUT_MS = 1500;

// Um simples TCP connect não basta: no Docker Desktop (Windows/WSL2), o proxy de
// porta publicada aceita a conexão mesmo com o processo do container já morto
// (crash loop), e só derruba a conexão na hora de repassar pro backend. Por isso
// exigimos uma resposta HTTP de verdade (qualquer status code já serve) — se a
// conexão for aceita e depois resetada sem resposta, isso conta como não saudável.
function checkOnce(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/", timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        res.resume();
        resolve(true);
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
  async waitUntilHealthy(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (await checkOnce(port)) {
        return true;
      }
      await sleep(POLL_INTERVAL_MS);
    }

    return false;
  }
}
