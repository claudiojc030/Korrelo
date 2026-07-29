/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Empacota só as dependências realmente usadas em .next/standalone. Roda
  // com um `node server.js` bem mais leve em RAM e disco do que carregar
  // node_modules inteiro via `next start`. Importante numa VPS pequena onde
  // o Korrelo não pode competir por recursos com os projetos hospedados.
  output: "standalone",
};

module.exports = nextConfig;
