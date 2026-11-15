#!/usr/bin/env node
/**
 * Sincroniza o harness e os módulos REAIS do Korrelo para o diretório do
 * repositório privado de laboratório.
 *
 * Uso:
 *   node apps/api/scripts/staging-lab-sync.mjs <destino>
 *
 * Nada é enviado (push) por este script.
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, "..");
const destination = resolve(process.argv[2] ?? "");

if (!process.argv[2] || !existsSync(destination)) {
  console.error("informe um diretório de destino existente");
  process.exit(2);
}

const projectFiles = [
  "domain/staging-planner.ts",
  "domain/staging-compose.ts",
  "domain/staging-execution.ts",
  "domain/staging-run.ts",
  "domain/staging-lease.ts",
  "domain/staging-capacity.ts",
  "domain/staging-plan-hash.ts",
  "domain/staging-context.ts",
  "domain/staging-docker-inventory.ts",
  "domain/staging-ephemeral-mongo.ts",
  "domain/project.repository.ts",
  "domain/managed-database.repository.ts",
  "domain/env-var.repository.ts",
  "domain/project.entity.ts",
  "domain/managed-database.entity.ts",
  "domain/env-var.entity.ts",
  "application/staging-execution.service.ts",
  "application/staging-capacity.service.ts",
  "infrastructure/worker-lock.ts",
  "infrastructure/docker-staging-runtime.ts",
  "infrastructure/docker-prebuilt-image.verifier.ts",
  "infrastructure/prisma-staging-run.repository.ts",
  "infrastructure/prisma-staging-port-lease.repository.ts",
  "infrastructure/read-only-staging-context.collector.ts",
];

for (const relative of projectFiles) {
  copy(join(apiRoot, "src", "modules", "projects", relative), join(destination, "src", "modules", "projects", relative));
}

for (const relative of ["infrastructure/command-runner.ts", "infrastructure/host-resources.ts", "infrastructure/prisma/prisma.service.ts"]) {
  copy(join(apiRoot, "src", relative), join(destination, "src", relative));
}

for (const relative of ["harness.ts", "synthetic-app/Dockerfile", "synthetic-app/server.js", "synthetic-app/package.json"]) {
  copy(join(apiRoot, "test", "staging-lab", relative), join(destination, "test", "staging-lab", relative));
}

const template = join(apiRoot, "test", "staging-lab", "lab-template");
for (const relative of [
  "package.json",
  "tsconfig.json",
  "README.md",
  ".gitignore",
  ".github/workflows/staging-lab.yml",
  "prisma/schema.prisma",
  "vendor/shared-types/package.json",
  "vendor/shared-types/index.d.ts",
  "vendor/shared-types/index.js",
]) {
  copy(join(template, relative), join(destination, relative));
}

console.log(`laboratório sincronizado em ${destination}`);

function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}
