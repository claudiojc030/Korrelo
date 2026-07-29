/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Empacota só as dependências realmente usadas em .next/standalone — roda
  // com um `node server.js` bem mais leve em RAM e disco do que carregar
  // node_modules inteiro via `next start`. Importante numa VPS pequena onde
  // o ForgeDesk não pode competir por recursos com os projetos hospedados.
  output: "standalone",
};

module.exports = nextConfig;
