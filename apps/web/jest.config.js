/**
 * @type {import('jest').Config}
 *
 * Testes do app web.
 *
 * O runner (jest + ts-jest) já existe no monorepo (dependência do app da
 * API, instalada na raiz pelo npm workspaces) - nada novo foi instalado
 * pra isso. O objetivo é conseguir testar o código que roda no servidor
 * (Server Components, proxy) sem precisar de navegador.
 */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/__tests__"],
  testMatch: ["<rootDir>/__tests__/**/*.test.ts", "<rootDir>/__tests__/**/*.test.tsx"],
  transform: {
    "^.+\\.(t|j)sx?$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.test.json" }],
  },
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  testPathIgnorePatterns: ["/node_modules/", "/.next/"],
};
