"use strict";

/**
 * HEALTH CHECK DO CORE COM RETRY (usado depois do restart do PM2).
 *
 * Incidente real: depois do `pm2 restart korrelo-api`, o rollout consultava
 * o health UMA vez. Nos primeiros segundos a API ainda não estava
 * escutando (ECONNREFUSED) e o rollout tratou isso como falha fatal:
 * rollback desnecessário, restart extra de API/Web e risco operacional.
 * Poucos minutos depois a API estava de pé e saudável (HTTP 200) - nunca
 * esteve quebrada.
 *
 * Aqui o health é polled:
 *   restart -> delay inicial -> checagem -> falhou -> espera -> checagem ...
 *   -> só declara falha se a API continuar ruim durante TODA a janela.
 *
 * O sleep usa o mesmo defaultSleep do resource guard (timer REFERENCIADO):
 * se o timer fosse unref'd, o processo do rollout poderia terminar
 * normalmente (exit 0) no meio da espera - foi exatamente o bug do
 * cooldown.
 */

const { defaultSleep } = require("./resource-guard.cjs");
const { sanitizeOutput } = require("./toolchain.cjs");

const DEFAULT_TIMEOUT_SEC = 60;
const DEFAULT_INTERVAL_SEC = 2;
const DEFAULT_INITIAL_DELAY_SEC = 2;
const MIN_TIMEOUT_SEC = 10;
const MIN_INTERVAL_SEC = 1;
const MAX_TIMEOUT_SEC = 3600;

/** Códigos de saída do curl que são claramente transitórios. */
const TRANSIENT_CURL_CODES = {
  7: "conexão recusada (a API ainda não está escutando)",
  28: "timeout da requisição",
  35: "erro de TLS",
  52: "resposta vazia do servidor",
  56: "conexão fechada pelo servidor",
};

function readNumber(env, key, fallback) {
  const raw = env ? env[key] : undefined;
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = Number.parseFloat(String(raw));
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** Configuração centralizada do health (com limites mínimos razoáveis). */
function readHealthConfig(env = process.env) {
  return {
    timeoutSec: clamp(
      readNumber(env, "KORRELO_ROLLOUT_HEALTH_TIMEOUT_SEC", DEFAULT_TIMEOUT_SEC),
      MIN_TIMEOUT_SEC,
      MAX_TIMEOUT_SEC,
    ),
    intervalSec: clamp(
      readNumber(env, "KORRELO_ROLLOUT_HEALTH_INTERVAL_SEC", DEFAULT_INTERVAL_SEC),
      MIN_INTERVAL_SEC,
      60,
    ),
    initialDelaySec: clamp(
      readNumber(env, "KORRELO_ROLLOUT_HEALTH_INITIAL_DELAY_SEC", DEFAULT_INITIAL_DELAY_SEC),
      0,
      60,
    ),
  };
}

/** Texto curto e sanitizado do erro (sem stack trace, sem segredo). */
function describeFailure(result, env = process.env) {
  const code = result && typeof result.code === "number" ? result.code : -1;
  const stderr = sanitizeOutput(String(result?.stderr ?? "").trim(), env)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)[0];
  const known = TRANSIENT_CURL_CODES[code];
  const suffix = stderr ? `: ${stderr.slice(0, 160)}` : "";
  return known ? `curl ${code} (${known})${suffix}` : `curl ${code}${suffix}`;
}

/**
 * Espera um endpoint ficar saudável.
 *
 * Sucesso = o comando de health sai com código 0 (o `curl -f` já trata
 * 4xx/5xx como falha). Falhas transitórias (conexão recusada, timeout,
 * socket reset, 502/503/504, API ainda não escutando) NÃO são sucesso:
 * apenas mantêm a espera até o timeout total.
 */
async function waitForHealthyEndpoint({
  url,
  label = "health",
  run,
  log = () => {},
  config = null,
  timeoutMsPerAttempt = 20_000,
  sleep = defaultSleep,
  now = () => Date.now(),
  env = process.env,
}) {
  const settings = config ?? readHealthConfig(env);
  const startedAt = now();
  let attempts = 0;
  let lastError = "desconhecido";

  // Delay inicial: o PM2 ainda está religando os processos.
  if (settings.initialDelaySec > 0) {
    await sleep(settings.initialDelaySec * 1000);
  }

  for (;;) {
    attempts += 1;
    const result = await run("curl", ["-fsS", "-o", "/dev/null", "--max-time", "10", url], {
      timeoutMs: timeoutMsPerAttempt,
    });
    const elapsedSec = Math.max(0, Math.round((now() - startedAt) / 1000));

    if (result.code === 0) {
      if (attempts > 1) {
        log(`[rollout] ${label}: saudável após ${elapsedSec}s (${attempts} tentativas)`);
      }
      return { ok: true, attempts, elapsedSec, lastError: null };
    }

    lastError = describeFailure(result, env);
    const remainingSec = settings.timeoutSec - elapsedSec;
    if (remainingSec <= 0) {
      return {
        ok: false,
        attempts,
        elapsedSec,
        lastError,
        reason:
          `timeout de ${settings.timeoutSec}s aguardando o health (${url}): ${lastError}. ` +
          `O Core pode ainda estar subindo (ou realmente quebrou).`,
      };
    }

    log(
      `[rollout] ${label}: aguardando\n` +
        `tentativa=${attempts}\n` +
        `elapsed=${elapsedSec}s\n` +
        `último erro=${lastError}\n` +
        `próxima checagem em ${settings.intervalSec}s`,
    );
    await sleep(settings.intervalSec * 1000);
  }
}

module.exports = {
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_INTERVAL_SEC,
  DEFAULT_INITIAL_DELAY_SEC,
  MIN_TIMEOUT_SEC,
  TRANSIENT_CURL_CODES,
  readHealthConfig,
  describeFailure,
  waitForHealthyEndpoint,
};
