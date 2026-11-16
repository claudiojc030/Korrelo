#!/usr/bin/env node
"use strict";

/**
 * Administração LOCAL do staging isolado (sem HTTP).
 *
 * - autenticação por token em arquivo 0600;
 * - config:set recebe JSON 0600, grava via repositório Prisma (sem SQL);
 * - nunca imprime valores de segredo;
 * - recusa reutilização de valor de EnvVar de produção;
 * - audit log append-only em ~/.korrelo/staging-admin.log;
 * - image:verify valida ID, commit, projeto (UUID ou slug), SO e arquitetura.
 *
 * Não executa staging, deploy nem migrations.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const DIST = path.join(__dirname, "..", "dist");

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function projectSlug(name) {
  const slug = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || null;
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8");
  const b = Buffer.from(String(right ?? ""), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function assertPrivateFile(file, label) {
  const stat = fs.statSync(file);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} precisa ter permissões 0600 (atual: ${(stat.mode & 0o777).toString(8)})`);
  }
  return stat;
}

function assertAuthenticated(args, env = process.env) {
  const tokenFile = args["token-file"] ?? path.join(os.homedir(), ".korrelo", "staging-admin.token");
  assertPrivateFile(tokenFile, "token");
  const expected = fs.readFileSync(tokenFile, "utf8").trim();
  const provided = args.token ?? env.KORRELO_STAGING_ADMIN_TOKEN ?? "";
  if (!expected || !timingSafeEqualText(provided, expected)) {
    throw new Error("token administrativo inválido");
  }
}

function verifyImageMetadata(metadata, expected) {
  const labels = metadata?.Config?.Labels ?? {};
  const acceptedProjects = new Set(
    [expected.projectId, projectSlot(expected.projectName)].filter(Boolean),
  );
  const issues = [];
  if (!/^sha256:[a-f0-9]{64}$/i.test(metadata?.Id ?? "")) {
    issues.push("image ID inválido");
  }
  if (expected.expectedImageId && metadata.Id !== expected.expectedImageId) {
    issues.push("image ID diverge do esperado");
  }
  if (!acceptedProjects.has(labels["korrelo.projectId"] ?? "")) {
    issues.push("label korrelo.projectId ausente/divergente");
  }
  if (labels["korrelo.commitSha"] !== expected.commitSha) {
    issues.push("label korrelo.commitSha ausente/divergente");
  }
  if ((metadata.Os ?? "").toLowerCase() !== "linux") issues.push("SO da imagem não é linux");
  if ((metadata.Architecture ?? "").toLowerCase() !== expected.architecture) {
    issues.push(`arquitetura ${metadata.Architecture ?? "?"} diverge de ${expected.architecture}`);
  }
  return { ok: issues.length === 0, issues, imageId: metadata?.Id ?? null };
}

function projectSlot(name) {
  return projectSlug(name);
}

function appendAudit(entry) {
  try {
    const dir = path.join(os.homedir(), ".korrelo");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "staging-admin.log"),
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      "utf8",
    );
  } catch {
    // auditoria best-effort não deve expor segredo nem impedir o comando
  }
}

function loadConfigFile(file) {
  assertPrivateFile(file, "arquivo de configuração");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (parsed?.allowEgress === true) {
    throw new Error("egress externo proibido no staging de homologação");
  }
  if (parsed?.mode !== "isolated") throw new Error("mode precisa ser isolated");
  const secrets = Array.isArray(parsed.secrets) ? parsed.secrets : [];
  for (const secret of secrets) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secret?.key ?? "")) {
      throw new Error("chave de segredo inválida");
    }
    if (/^(KORRELO_|COMPOSE_|DOCKER_)/.test(secret.key)) {
      throw new Error(`segredo reservado: ${secret.key}`);
    }
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  assertAuthenticated(args);

  if (command === "image:verify") {
    const reference = args.reference;
    if (!reference) throw new Error("--reference é obrigatório");
    if (!args["project-id"]) throw new Error("--project-id é obrigatório");
    if (!/^[a-f0-9]{40}$/i.test(String(args.commit ?? ""))) {
      throw new Error("--commit precisa ser SHA completo (40 hex)");
    }
    const [metadata] = JSON.parse(
      execFileSync("docker", ["image", "inspect", reference], { encoding: "utf8", timeout: 20_000 }),
    );
    const result = verifyImageMetadata(metadata, {
      projectId: args["project-id"],
      projectName: args["project-name"],
      commitSha: String(args.commit ?? "").toLowerCase(),
      expectedImageId: args["expected-id"] ?? null,
      architecture: args.architecture ?? "amd64",
    });
    appendAudit({
      action: "image:verify",
      reference,
      ok: result.ok,
      imageId: result.imageId,
      issues: result.issues,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (!["config:set", "config:show", "config:delete"].includes(command)) {
    throw new Error("comandos: config:set | config:show | config:delete | image:verify");
  }

  const projectId = args["project-id"];
  if (!projectId) throw new Error("--project-id é obrigatório");

  const { PrismaClient } = require("@prisma/client");
  const { EnvVarCipher } = require(path.join(DIST, "infrastructure", "crypto", "env-var-cipher.js"));
  const {
    PrismaStagingConfigRepository,
  } = require(path.join(
    DIST,
    "modules",
    "projects",
    "infrastructure",
    "prisma-staging-config.repository.js",
  ));
  const prisma = new PrismaClient();
  const cipher = new EnvVarCipher();
  const repository = new PrismaStagingConfigRepository(prisma, cipher);

  try {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new Error("projeto não encontrado");

    if (command === "config:show") {
      const config = await repository.findByProjectId(projectId);
      process.stdout.write(
        `${JSON.stringify(
          config
            ? {
                projectId: config.projectId,
                mode: config.mode,
                ttlMinutes: config.ttlMinutes,
                allowEgress: config.allowEgress,
                app: config.app,
                dependencies: config.dependencies.map((dependency) => ({
                  name: dependency.name,
                  kind: dependency.kind,
                  mode: dependency.mode,
                  envKey: dependency.envKey,
                })),
                secretKeys: config.secrets.map((secret) => secret.key),
              }
            : null,
        )}\n`,
      );
      return;
    }

    if (command === "config:delete") {
      await repository.deleteByProjectId(projectId);
      appendAudit({ action: "config:delete", projectId });
      process.stdout.write(`${JSON.stringify({ ok: true, projectId })}\n`);
      return;
    }

    const input = loadConfigFile(args.file);
    const productionEnv = await prisma.envVar.findMany({ where: { projectId } });
    for (const secret of input.secrets ?? []) {
      for (const envVar of productionEnv) {
        let value = envVar.value;
        try {
          value = cipher.decrypt(envVar.value);
        } catch {
          throw new Error(`não foi possível comparar o segredo ${secret.key} com EnvVar de produção`);
        }
        if (value === secret.value) {
          throw new Error(`segredo ${secret.key} reutiliza um valor de produção; recusado`);
        }
        if (envVar.key === secret.key) {
          throw new Error(`chave ${secret.key} também existe em EnvVar de produção; recusado`);
        }
      }
    }

    const saved = await repository.save(projectId, input);
    appendAudit({
      action: "config:set",
      projectId,
      secretKeys: saved.secrets.map((secret) => secret.key),
      dependencies: saved.dependencies.map((dependency) => dependency.name),
    });
    process.stdout.write(
      `${JSON.stringify({ ok: true, projectId, secretKeys: saved.secrets.map((secret) => secret.key) })}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = {
  parseArgs,
  projectSlug,
  timingSafeEqualText,
  assertPrivateFile,
  verifyImageMetadata,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
