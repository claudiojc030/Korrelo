module.exports = {
  apps: [
    {
      name: "korrelo-api",
      cwd: "./apps/api",
      script: "dist/main.js",
      env: { NODE_ENV: "production" },
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
      env: { NODE_ENV: "production", PORT: 3000 },
      restart_delay: 3000,
      max_restarts: 10,
    },
  ],
};
