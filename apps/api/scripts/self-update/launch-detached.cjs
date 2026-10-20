#!/usr/bin/env node
"use strict";

/**
 * LAUNCHER DETACHED do self-update.
 *
 * PROBLEMA REAL (incidente na VPS): o rollout era disparado pelo terminal web
 * do próprio Korrelo. Quando o rollout fez `pm2 restart korrelo-api`, o PM2
 * matou a ÁRVORE de processos da API - e o rollout (que era filho da API)
 * morreu junto. Resultado: lock órfão, drain órfão, snapshot-after /
 * compare-projects / git-verify / worker-release nunca aconteceram.
 *
 * SOLUÇÃO: DOUBLE FORK.
 *   1. a API spawna este launcher com `detached: true` + `unref()`;
 *   2. este launcher spawna o comando real (o rollout) e sai IMEDIATAMENTE;
 *   3. ao sair, o rollout é re-parentado para o init (PID 1).
 *
 * Resultado: o rollout NÃO é mais descendente da API, então o
 * `pm2 restart korrelo-api` (que mata a árvore da API) não o alcança.
 * O rollout sobrevive ao restart da API e do Web, ao fechamento do navegador
 * e à queda do WebSocket.
 *
 * Uso:
 *   node launch-detached.cjs --pid-file <arquivo> --log-file <arquivo> \
 *        --cwd <dir> -- <comando> [args...]
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function parseArgs(argv) {
  const options = {
    pidFile: null,
    logFile: null,
    jobFile: null,
    cwd: process.cwd(),
    command: null,
    args: [],
  };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--pid-file") {
      options.pidFile = argv[index + 1];
      index += 2;
      continue;
    }
    if (arg === "--log-file") {
      options.logFile = argv[index + 1];
      index += 2;
      continue;
    }
    if (arg === "--job-file") {
      options.jobFile = argv[index + 1];
      index += 2;
      continue;
    }
    if (arg === "--cwd") {
      options.cwd = argv[index + 1];
      index += 2;
      continue;
    }
    if (arg === "--") {
      options.command = argv[index + 1];
      options.args = argv.slice(index + 2);
      break;
    }
    index += 1;
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.command) {
    process.stderr.write("launch-detached: comando ausente\n");
    process.exit(2);
  }

  // O log do runner: arquivo próprio, append-only. O stdout/stderr do
  // processo real vão direto para ele (sem passar pelo socket da API).
  let stdio = ["ignore", "ignore", "ignore"];
  if (options.logFile) {
    fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
    const fd = fs.openSync(options.logFile, "a");
    stdio = ["ignore", fd, fd];
  }

  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    detached: true,
    stdio,
    // O arquivo do job vai por env: o rollout (e não a API) é quem persiste
    // o progresso e o resultado final - a API pode reiniciar no meio.
    env: options.jobFile
      ? { ...process.env, KORRELO_SELF_UPDATE_JOB_FILE: options.jobFile }
      : process.env,
  });

  // O PID do processo real (o que fica desacoplado).
  if (options.pidFile && child.pid) {
    try {
      fs.mkdirSync(path.dirname(options.pidFile), { recursive: true });
      fs.writeFileSync(
        options.pidFile,
        JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }, null, 2),
      );
    } catch {
      /* best effort */
    }
  }

  // Desacopla: o processo real não morre quando este launcher sai.
  //
  // O `unref()` aqui é CORRETO e deve permanecer: o launcher existe só
  // para fazer o double fork. Sem o unref, o launcher ficaria segurando o
  // event loop (e o rollout, que já foi re-parentado para o init, ficaria
  // como filho de um processo que não morre - quebrando o desacoplamento).
  child.unref();

  // Sai agora: o runner é re-parentado para o init (double fork).
  process.exit(0);
}

main();
