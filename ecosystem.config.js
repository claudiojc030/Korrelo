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
