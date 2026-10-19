module.exports = {
  apps: [
    {
      name: "korrelo-api",
      cwd: "./apps/api",
      script: "dist/main.js",
      // O Korrelo em si não deve competir por RAM com os projetos hospedados
      // (é pra sobrar o máximo possível pra eles). --max-old-space-size fixa
      // um teto baixo pro V8 (sem isso ele mira na RAM total da VPS); o
      // max_memory_restart do pm2 é uma rede de segurança à parte - reinicia
      // sozinho se algum vazamento passar do heap configurado.
      env: { NODE_ENV: "production", NODE_OPTIONS: "--max-old-space-size=192" },
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
      env: { NODE_ENV: "production", PORT: 3000, NODE_OPTIONS: "--max-old-space-size=192" },
      max_memory_restart: "256M",
      restart_delay: 3000,
      max_restarts: 10,
    },
  ],
};
