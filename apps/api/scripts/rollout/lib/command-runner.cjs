"use strict";

/**
 * Executor de comandos para os scripts de rollout.
 *
 * Característica importante: NUNCA lança exceção por comando que falhou -
 * devolve { code, stdout, stderr, timedOut }. O rollout precisa reagir a
 * "git status saiu com 1" ou "docker inspect falhou" sem virar exceção.
 *
 * Nenhum comando aqui escreve em container/volume/rede de projeto: os únicos
 * comandos Docker usados são de LEITURA (ps, inspect, stats).
 */
const { spawn } = require("node:child_process");

const DEFAULT_TIMEOUT_MS = 60_000;

function run(command, args = [], options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, cwd, env, input } = options;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: -1, stdout: "", stderr: String(error && error.message ? error.message : error), timedOut: false });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* já morreu */
      }
    }, timeoutMs);
    // O `unref()` aqui é CORRETO e deve permanecer:
    //
    // - o child process (NÃO é detached e NÃO é unref'd) mantém o event
    //   loop vivo por conta própria, então o timeout de supervisão sempre
    //   dispara se o comando travar;
    // - se o comando terminar antes, o timer unref'd NÃO segura o processo
    //   do rollout por até `timeoutMs` (60s no default) - sem ele, todo
    //   comando do rollout atrasaria o fim do processo em até 1 minuto.
    //
    // (Diferente do sleep do resource guard, que é o ÚNICO handle ativo
    // durante o cooldown - lá o unref matava o rollout, exit code 0.)
    timer.unref?.();

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(error.message ?? error), timedOut });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code === null ? -1 : code, stdout, stderr, timedOut });
    });

    if (input !== undefined) {
      child.stdin?.end(input);
    } else {
      child.stdin?.end();
    }
  });
}

/** Verdadeiro quando o binário existe e responde. */
async function commandExists(command, runner = run) {
  const result = await runner(command, ["--version"], { timeoutMs: 5_000 });
  return result.code === 0;
}

module.exports = { run, commandExists, DEFAULT_TIMEOUT_MS };
