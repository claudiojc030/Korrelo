const fs = require("node:fs");
const path = require("node:path");

/**
 * RUNTIME DO CORE.
 *
 * O runtime novo da migração Node 22 é instalado LADO A LADO em
 * /opt/korrelo/node/<versão> (symlink `current`), sem tocar no /usr/bin/node.
 *
 * O interpretador é resolvido AQUI, no carregamento do ecosystem:
 *   1. KORRELO_NODE_BIN, se existir e apontar para um binário válido;
 *   2. /opt/korrelo/node/current/bin/node (instalação padrão), se existir;
 *   3. nenhum -> PM2 usa o node do PATH (comportamento original = Node 20).
 *
 * Por que não depender só de `export KORRELO_NODE_BIN`: PM2 salva o processo
 * em ~/.pm2/dump.pm2 e o `pm2 resurrect` do boot usa o dump. Um export de
 * sessão SSH não sobrevive a logout/reboot. Com a detecção automática, um
 * `pm2 restart ecosystem.config.js` (e um dump regenerado) continuam usando
 * o runtime novo.
 *
 * ROLLBACK: `KORRELO_NODE_BIN=$(command -v node) pm2 restart ecosystem.config.js --update-env`
 * (ou remova o symlink /opt/korrelo/node/current).
 */
const DEFAULT_NODE_BIN = "/opt/korrelo/node/current/bin/node";

function resolveNodeInterpreter() {
  const candidate = process.env.KORRELO_NODE_BIN || DEFAULT_NODE_BIN;
  try {
    if (candidate && fs.existsSync(candidate)) return candidate;
  } catch {
    // caminho inválido/ilegível: cai no PATH
  }
  if (process.env.KORRELO_NODE_BIN) {
    console.warn(
      `[korrelo] KORRELO_NODE_BIN="${candidate}" não existe; usando o node do PATH.`,
    );
  }
  return null;
}

const NODE_INTERPRETER = resolveNodeInterpreter();

function interpreterField() {
  return NODE_INTERPRETER ? { interpreter: NODE_INTERPRETER } : {};
}

/**
 * Garante que os PROCESSOS FILHOS do Core (inclusive o self-update, que roda
 * `npm ci`/build) usem o npm do MESMO runtime. Sem isso, o build continuaria
 * no npm do Node 20 do PATH.
 */
function runtimeEnv() {
  if (!NODE_INTERPRETER) return {};
  const binDir = path.dirname(NODE_INTERPRETER);
  const current = process.env.PATH || "";
  return { PATH: current ? `${binDir}${path.delimiter}${current}` : binDir };
}

module.exports = {
  apps: [
    {
      name: "korrelo-api",
      cwd: "./apps/api",
      script: "dist/main.js",
      ...interpreterField(),
      // O Korrelo em si não deve competir por RAM com os projetos hospedados
      // (é pra sobrar o máximo possível pra eles). --max-old-space-size fixa
      // um teto baixo pro V8 (sem isso ele mira na RAM total da VPS); o
      // max_memory_restart do pm2 é uma rede de segurança à parte - reinicia
      // sozinho se algum vazamento passar do heap configurado.
      env: { NODE_ENV: "production", NODE_OPTIONS: "--max-old-space-size=192", ...runtimeEnv() },
      max_memory_restart: "256M",
      restart_delay: 3000,
      max_restarts: 10,
      // Shutdown gracoso: o worker de deploy precisa de tempo para entrar em
      // draining e terminar o job em andamento. Sem kill_timeout, o PM2 mata
      // o processo em ~1,6s (SIGKILL) e um deploy pode ficar pela metade.
      // 30s é o tempo limite; o processo continua rodando até lá.
      kill_timeout: 30000,
      // Se a porta não estiver livre em 10s, o processo morre em vez de
      // ficar pendurado (o default do PM2 é esperar indefinidamente).
      listen_timeout: 10000,
      // Backoff exponencial: evita que um Core com bug entre em loop de
      // restart queimando a CPU de 1 vCPU da VPS.
      exp_backoff_restart_delay: 5000,
    },
    {
      // output: "standalone" (next.config.js) gera um server.js que só carrega
      // as dependências realmente usadas, bem mais leve em RAM do que
      // "next start" (que roda em cima do node_modules inteiro do monorepo).
      // scripts/setup-vps.sh copia .next/static e public/ pra dentro dessa
      // pasta depois do build (o standalone não inclui isso sozinho).
      name: "korrelo-web",
      cwd: "./apps/web/.next/standalone/apps/web",
      script: "server.js",
      ...interpreterField(),
      env: { NODE_ENV: "production", PORT: 3000, NODE_OPTIONS: "--max-old-space-size=192", ...runtimeEnv() },
      max_memory_restart: "256M",
      restart_delay: 3000,
      max_restarts: 10,
    },
  ],
};
