"use strict";

/**
 * PRIMITIVA DE EXECUÇÃO DE PROCESSO (backup/restore).
 *
 * Um único lugar para rodar dump/restore com:
 * - stdout em STREAM direto pro arquivo (nunca um Buffer inteiro na RAM);
 * - stderr LIMITADO (ring buffer - um dump pode cuspir muito);
 * - timeout por AUSÊNCIA DE ATIVIDADE (bytes pararam de chegar) e timeout
 *   máximo opcional (o dump pode levar horas, mas não pode ficar parado);
 * - exit code explícito;
 * - erro de escrita no arquivo (ENOSPC/permissão) tratado como FALHA;
 * - cancelamento (SIGTERM -> SIGKILL).
 *
 * É o motor usado pelo cron (apps/api/scripts/backup.js), pelo botão
 * "Fazer backup agora" (scripts/export-database.sh) e pelo restore
 * (scripts/restore-database.sh) - assim não existem duas implementações
 * de dump com comportamentos diferentes.
 */

const fs = require("node:fs");
const { spawn } = require("node:child_process");

const DEFAULT_STDERR_LIMIT = 64 * 1024; // 64 KB
const DEFAULT_STDOUT_LIMIT = 64 * 1024;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 min sem byte nenhum
const DEFAULT_MAX_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12h de teto
const KILL_GRACE_MS = 5_000;

/**
 * @typedef {object} RunResult
 * @property {number|null} code      exit code (null se não terminou)
 * @property {string|null} signal    sinal que matou o processo
 * @property {string} stdout         stdout capturado (limitado) quando não há stdoutPath
 * @property {string} stderr         stderr capturado (limitado)
 * @property {number} bytesWritten   bytes gravados no stdoutPath
 * @property {boolean} timedOut
 * @property {boolean} inactivityTimedOut
 * @property {boolean} maxTimedOut
 * @property {Error|null} error      erro de spawn
 * @property {Error|null} writeError erro de escrita no arquivo de saída
 * @property {number} durationMs
 */

/**
 * Executa um comando.
 *
 * @param {object} options
 * @param {string} options.command
 * @param {string[]} [options.args]
 * @param {string} [options.cwd]
 * @param {object} [options.env]
 * @param {string|null} [options.stdoutPath]  quando setado, o stdout vira stream pro arquivo
 * @param {number} [options.stdoutMode]       permissão do arquivo de saída (default 600)
 * @param {string|null} [options.stdinPath]    arquivo alimentado no stdin
 * @param {number} [options.stderrLimit]
 * @param {number} [options.stdoutLimit]
 * @param {number} [options.inactivityTimeoutMs]
 * @param {number} [options.maxTimeoutMs]
 * @param {(bytes:number)=>void} [options.onProgress]
 * @returns {Promise<RunResult>}
 */
function runProcess(options) {
  const {
    command,
    args = [],
    cwd,
    env,
    stdoutPath = null,
    stdoutMode = 0o600,
    stdinPath = null,
    stderrLimit = DEFAULT_STDERR_LIMIT,
    stdoutLimit = DEFAULT_STDOUT_LIMIT,
    inactivityTimeoutMs = DEFAULT_INACTIVITY_TIMEOUT_MS,
    maxTimeoutMs = DEFAULT_MAX_TIMEOUT_MS,
    onProgress = null,
    killGraceMs = KILL_GRACE_MS,
  } = options || {};

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child = null;
    let outStream = null;
    let inStream = null;
    let stderr = "";
    let stdout = "";
    let bytesWritten = 0;
    let lastActivityAt = Date.now();
    let timedOut = false;
    let inactivityTimedOut = false;
    let maxTimedOut = false;
    let settled = false;
    let writeError = null;
    let stdinError = null;
    let exitCode = null;
    let exitSignal = null;
    let childClosed = false;
    let outClosed = stdoutPath === null;

    const touch = () => {
      lastActivityAt = Date.now();
    };

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      try {
        if (inStream) inStream.destroy();
      } catch {
        /* já fechado */
      }
      try {
        if (outStream) outStream.destroy();
      } catch {
        /* já fechado */
      }
      resolve({
        code: exitCode,
        signal: exitSignal,
        stdout,
        stderr: stderr.slice(0, stderrLimit),
        bytesWritten,
        timedOut,
        inactivityTimedOut,
        maxTimedOut,
        error: null,
        writeError,
        durationMs: Date.now() - startedAt,
        ...extra,
      });
    };

    const kill = (isTimeout) => {
      if (isTimeout) timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* já morreu */
      }
      const killer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* já morreu */
        }
      }, killGraceMs);
      killer.unref?.();
    };

    try {
      child = spawn(command, args, {
        cwd,
        env: env || process.env,
        // stdin é "pipe" (e fechado imediatamente quando não há arquivo
        // pra alimentar) pra permitir restaurar mandando o dump por stdin.
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        stdout: "",
        stderr: "",
        bytesWritten: 0,
        timedOut: false,
        inactivityTimedOut: false,
        maxTimedOut: false,
        error: error instanceof Error ? error : new Error(String(error)),
        writeError: null,
        durationMs: 0,
      });
      return;
    }

    // stderr: buffer limitado em memória (nunca cresce sem limite).
    child.stderr?.on("data", (chunk) => {
      touch();
      if (stderr.length < stderrLimit) {
        stderr += chunk.toString("utf-8").slice(0, stderrLimit - stderr.length);
      }
    });

    if (stdoutPath) {
      // Stream de verdade: backpressure do Node cuida da memória (nada de
      // Buffer gigante) e erro de escrita (ENOSPC/permissão) chega aqui.
      outStream = fs.createWriteStream(stdoutPath, { mode: stdoutMode, flags: "w" });
      outStream.on("error", (error) => {
        if (!writeError) writeError = error;
        // Erro de escrita (ENOSPC/permissão) NÃO é timeout: o dump para
        // porque não dá pra escrever, não porque travou.
        kill(false);
      });
      outStream.on("close", () => {
        outClosed = true;
        maybeFinish();
      });
      child.stdout?.on("data", (chunk) => {
        touch();
        bytesWritten += chunk.length;
        if (typeof onProgress === "function") {
          try {
            onProgress(bytesWritten);
          } catch {
            /* progresso é best effort */
          }
        }
      });
      child.stdout?.pipe(outStream);
    } else {
      child.stdout?.on("data", (chunk) => {
        touch();
        if (stdout.length < stdoutLimit) {
          stdout += chunk.toString("utf-8").slice(0, stdoutLimit - stdout.length);
        }
      });
    }

    if (stdinPath) {
      inStream = fs.createReadStream(stdinPath);
      inStream.on("error", (error) => {
        if (!stdinError) stdinError = error;
        kill(false);
      });
      inStream.pipe(child.stdin);
      child.stdin?.on("error", () => {
        // EPIPE: o processo morreu antes de ler tudo - tratado pelo exit code.
      });
    } else {
      child.stdin?.end();
    }

    function maybeFinish() {
      if (childClosed && outClosed) {
        finish({
          error: stdinError,
        });
      }
    }

    // Watchdog: timeout por AUSÊNCIA DE ATIVIDADE (bytes pararam) e teto
    // máximo. Enquanto bytes chegam, o dump está vivo - mesmo que leve horas.
    const watchdog = setInterval(() => {
      const now = Date.now();
      const inactiveFor = now - lastActivityAt;
      if (inactivityTimeoutMs > 0 && inactiveFor > inactivityTimeoutMs) {
        inactivityTimedOut = true;
        kill(true);
        return;
      }
      if (maxTimeoutMs > 0 && now - startedAt > maxTimeoutMs) {
        maxTimedOut = true;
        kill(true);
      }
    }, 1_000);
    watchdog.unref?.();

    child.on("error", (error) => {
      finish({ error: error instanceof Error ? error : new Error(String(error)) });
    });

    child.on("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      childClosed = true;
      if (outStream) {
        try {
          outStream.end();
        } catch {
          /* já fechado */
        }
      }
      // O 'close' do stream de saída costuma vir ANTES do 'close' do
      // processo - por isso maybeFinish é chamado nos dois lados.
      maybeFinish();
    });
  });
}

module.exports = {
  runProcess,
  DEFAULT_STDERR_LIMIT,
  DEFAULT_STDOUT_LIMIT,
  DEFAULT_INACTIVITY_TIMEOUT_MS,
  DEFAULT_MAX_TIMEOUT_MS,
};
