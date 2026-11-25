import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "..", "measure-project-profile.sh");

test("script existe e é executável por bash", async () => {
  const body = await readFile(scriptPath, "utf8");
  assert.match(body, /^#!\/usr\/bin\/env bash/);
});

test("exige autorização explícita e confirmação antes de executar", async () => {
  const body = await readFile(scriptPath, "utf8");
  assert.match(body, /KORRELO_LAB_AUTHORIZED/);
  assert.match(body, /--yes/);
  assert.match(body, /--dry-run/);
});

test("não contém prune destrutivo nem remoção por filtro/curinga", async () => {
  const body = await readFile(scriptPath, "utf8");
  // Comentários podem citar o que é proibido; só linhas executáveis importam.
  const executable = body
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const forbidden = [
    "docker system prune",
    "docker builder prune",
    "docker image prune",
    "docker volume prune",
    "docker network prune",
    "docker container prune",
    "--filter",
  ];
  for (const item of forbidden) {
    assert.equal(executable.includes(item), false, `comando proibido encontrado: ${item}`);
  }
});

test("usa builder descartável próprio e nunca altera o builder padrão", async () => {
  const body = await readFile(scriptPath, "utf8");
  assert.match(body, /--driver docker-container/);
  assert.match(body, /docker buildx create --name "\$BUILDER_NAME"/);
  assert.match(body, /docker buildx build --builder "\$BUILDER_NAME"/);
  assert.equal(/--use\b/.test(body), false);
  assert.match(body, /docker update --memory/);
});

test("contexto do build vem de git archive do commit fixado", async () => {
  const body = await readFile(scriptPath, "utf8");
  assert.match(body, /git -C "\$REPO" archive --format=tar "\$COMMIT"/);
  assert.match(body, /rev-parse HEAD/);
});

test("limpeza só remove nomes exclusivos da execução", async () => {
  const body = await readFile(scriptPath, "utf8");
  assert.match(body, /PREFIX="korrelo-lab-\$\{RUN_ID\}"/);
  assert.match(body, /case "\$STAGING_NAME" in "\$PREFIX"\*/);
  assert.match(body, /case "\$NETWORK_NAME" in "\$PREFIX"\*/);
  assert.match(body, /docker buildx rm "\$BUILDER_NAME"/);
});

test("recusa Docker context remoto", async () => {
  const body = await readFile(scriptPath, "utf8");
  assert.match(body, /docker context inspect/);
  assert.match(body, /ssh:\/\/\*/);
  assert.match(body, /tcp:\/\/\*/);
  assert.match(body, /context remoto não é permitido/);
});

test("contexto não pode carregar segredo versionado e precisa de .dockerignore", async () => {
  const body = await readFile(scriptPath, "utf8");
  assert.match(body, /grep -qx .*dockerignore/);
  assert.match(body, /SENSITIVE_FILES=/);
  assert.match(body, /commit sem \.dockerignore/);
});

test("build usa ambiente mínimo e banco do staging é MONGODB_URI efêmero", async () => {
  const body = await readFile(scriptPath, "utf8");
  assert.match(body, /BUILD_ENV=\(env -i/);
  assert.match(body, /MONGODB_URI=mongodb:\/\/\$MONGO_NAME/);
  assert.equal(body.includes('MONGO_URL=mongodb://'), false);
});

test("amostragem exige cobertura mínima e builder recriado invalida a medição", async () => {
  const body = await readFile(scriptPath, "utf8");
  assert.match(body, /BUILD_MIN_SAMPLES/);
  assert.match(body, /STAGING_MIN_SAMPLES/);
  assert.match(body, /BUILDER_ID_BEFORE/);
  assert.match(body, /BUILDER_ID_AFTER/);
  assert.match(body, /builder foi recriado durante o build/);
});
