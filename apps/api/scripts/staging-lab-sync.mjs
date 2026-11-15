#!/usr/bin/env node
/**
 * Sincroniza o harness e os módulos REAIS do Korrelo para o diretório do
 * repositório privado de laboratório.
 *
 * Uso:
 *   node apps/api/scripts/staging-lab-sync.mjs <destino>
 *
 * O destino deve estar vazio ou ser um clone do repositório de laboratório.
 * Nada é enviado (push) por este script.
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, "..");
const projects = join(apiRoot, "src", "modules", "projects");
const labSource = join(apiRoot, "test", "staging-lab");
const destination = resolve(process.argv[2] ?? "");

if (!process.argv[2] || !existsSync(destination)) {
  console.error("informe um diretório de destino existente");
  process.exit(2);
}

const sourceFiles = [
  "domain/staging-planner.ts",
  "domain/staging-compose.ts",
  "domain/staging-execution.ts",
  "domain/staging-run.ts",
  "domain/staging-lease.ts",
  "domain/staging-capacity.ts",
  "domain/staging-plan-hash.ts",
  "application/staging-execution.service.ts",
  "infrastructure/worker-lock.ts",
  "infrastructure/docker-staging-runtime.ts",
  "infrastructure/docker-prebuilt-image.verifier.ts",
];

for (const relative of sourceFiles) {
  const target = join(destination, "src", "modules", "projects", relative);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(projects, relative), target);
}

const labFiles = [
  "harness.ts",
  "test-run-repository.ts",
  "synthetic-app/Dockerfile",
  "synthetic-app/server.js",
];

for (const relative of labFiles) {
  const target = join(destination, "test", "staging-lab", relative);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(labSource, relative), target);
}

const template = join(labSource, "lab-template");
for (const relative of ["package.json", "tsconfig.json", "README.md", ".gitignore", ".github/workflows/staging-lab.yml"]) {
  const target = join(destination, relative);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(template, relative), target);
}

console.log(`laboratório sincronizado em ${destination}`);
