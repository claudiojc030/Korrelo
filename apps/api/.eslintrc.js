module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    sourceType: "module",
    ecmaVersion: 2021,
  },
  plugins: ["@typescript-eslint"],
  extends: ["plugin:@typescript-eslint/recommended"],
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: ["dist", "node_modules"],
  rules: {
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    "@typescript-eslint/no-empty-function": "off",
    "@typescript-eslint/no-non-null-assertion": "off",
  },
  overrides: [
    {
      files: ["**/*.spec.ts"],
      rules: {
        "@typescript-eslint/no-require-imports": "off",
      },
    },
  ],
};
