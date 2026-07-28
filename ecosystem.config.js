module.exports = {
  apps: [
    {
      name: "forgedesk-api",
      cwd: "./apps/api",
      script: "dist/main.js",
      env: { NODE_ENV: "production" },
      restart_delay: 3000,
      max_restarts: 10,
    },
    {
      name: "forgedesk-web",
      cwd: "./apps/web",
      script: "npm",
      args: "run start",
      env: { NODE_ENV: "production", PORT: 3000 },
      restart_delay: 3000,
      max_restarts: 10,
    },
  ],
};
