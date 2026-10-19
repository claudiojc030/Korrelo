"use strict";

/**
 * Snapshot READ-ONLY dos containers de projeto (Mesatta, Evolution) antes e
 * depois do rollout do Korrelo.
 *
 * O rollout do Korrelo NÃO pode alterar nenhum container de projeto. Este
 * snapshot é a PROVA disso: se qualquer campo comparado mudar, o rollout é
 * considerado FALHA CRÍTICA.
 *
 * Campos comparados (por container):
 *   id (Container ID), image, startedAt, restartCount, memoryLimitBytes,
 *   memorySwapBytes, restartPolicy, health, networks, mounts, ports.
 *
 * Somente comandos de LEITURA no Docker: `docker ps` e `docker inspect`.
 */

const COMPARED_FIELDS = [
  "id",
  "image",
  "startedAt",
  "restartCount",
  "memoryLimitBytes",
  "memorySwapBytes",
  "restartPolicy",
  "health",
  "networks",
  "ports",
  "mounts",
];

function parseInspect(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function normalizeNetworks(networks) {
  if (!networks || typeof networks !== "object") return [];
  return Object.keys(networks).sort();
}

function normalizePorts(ports) {
  if (!ports || typeof ports !== "object") return [];
  return Object.keys(ports).sort();
}

function normalizeMounts(mounts) {
  if (!Array.isArray(mounts)) return [];
  return mounts
    .map((mount) => ({
      type: mount.Type ?? null,
      name: mount.Name ?? null,
      source: mount.Source ?? null,
      destination: mount.Destination ?? null,
    }))
    .sort((a, b) => String(a.destination).localeCompare(String(b.destination)));
}

/**
 * Lista os containers de um projeto pelo label do compose.
 * (o nome do projeto no compose do Korrelo é o nome do container de app)
 */
async function listProjectContainers({ project, run }) {
  const result = await run(
    "docker",
    ["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Names}}"],
    { timeoutMs: 15_000 },
  );
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Lê (sem alterar) o estado de um container. */
async function inspectContainer({ name, run }) {
  const result = await run("docker", ["inspect", "--format", "{{json .}}", name], { timeoutMs: 15_000 });
  if (result.code !== 0) return null;
  const parsed = parseInspect(result.stdout);
  if (!parsed) return null;

  return {
    name: String(parsed.Name ?? name).replace(/^\//, ""),
    id: parsed.Id ?? null,
    image: parsed.Config?.Image ?? null,
    startedAt: parsed.State?.StartedAt ?? null,
    restartCount: typeof parsed.RestartCount === "number" ? parsed.RestartCount : null,
    memoryLimitBytes: parsed.HostConfig?.Memory ?? null,
    memorySwapBytes: parsed.HostConfig?.MemorySwap ?? null,
    restartPolicy: parsed.HostConfig?.RestartPolicy?.Name ?? null,
    health: parsed.State?.Health?.Status ?? null,
    networks: normalizeNetworks(parsed.NetworkSettings?.Networks),
    ports: normalizePorts(parsed.NetworkSettings?.Ports),
    mounts: normalizeMounts(parsed.Mounts),
  };
}

/**
 * Captura o snapshot de todos os projetos configurados.
 */
async function captureProjectSnapshot({ projects, run, now = new Date() }) {
  const captured = { at: now.toISOString(), projects: {} };

  for (const project of projects) {
    const names = await listProjectContainers({ project: project.name, run });
    const containers = {};
    for (const name of names) {
      const snapshot = await inspectContainer({ name, run });
      if (snapshot) containers[name] = snapshot;
    }
    captured.projects[project.name] = { containers };
  }

  return captured;
}

function valuesEqual(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((value, index) => JSON.stringify(value) === JSON.stringify(b[index]));
  }
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Compara dois snapshots. Retorna a lista de divergências.
 */
function compareProjectSnapshots(before, after) {
  const changes = [];
  const projectNames = new Set([
    ...Object.keys(before?.projects ?? {}),
    ...Object.keys(after?.projects ?? {}),
  ]);

  for (const project of projectNames) {
    const beforeProject = before?.projects?.[project]?.containers ?? {};
    const afterProject = after?.projects?.[project]?.containers ?? {};
    const containerNames = new Set([...Object.keys(beforeProject), ...Object.keys(afterProject)]);

    for (const container of containerNames) {
      const beforeContainer = beforeProject[container];
      const afterContainer = afterProject[container];

      if (!beforeContainer) {
        changes.push({ project, container, field: "existence", before: null, after: "criado" });
        continue;
      }
      if (!afterContainer) {
        changes.push({ project, container, field: "existence", before: "presente", after: "ausente" });
        continue;
      }

      for (const field of COMPARED_FIELDS) {
        if (!valuesEqual(beforeContainer[field], afterContainer[field])) {
          changes.push({
            project,
            container,
            field,
            before: beforeContainer[field] ?? null,
            after: afterContainer[field] ?? null,
          });
        }
      }
    }
  }

  return { ok: changes.length === 0, changes };
}

/** Resumo curto (sem segredos) para o log do rollout. */
function formatSnapshotSummary(snapshot) {
  const lines = [];
  for (const [project, data] of Object.entries(snapshot.projects ?? {})) {
    for (const [container, info] of Object.entries(data.containers ?? {})) {
      lines.push(
        `  ${project}/${container}: id=${shortId(info.id)} image=${info.image ?? "?"} ` +
          `startedAt=${info.startedAt ?? "?"} restarts=${info.restartCount ?? "?"} ` +
          `mem=${info.memoryLimitBytes ?? 0} swap=${info.memorySwapBytes ?? 0} ` +
          `restart=${info.restartPolicy ?? "?"} health=${info.health ?? "n/a"} ` +
          `networks=[${(info.networks ?? []).join(",")}] ports=[${(info.ports ?? []).join(",")}]`,
      );
    }
  }
  return lines.join("\n");
}

function shortId(id) {
  return id ? String(id).slice(0, 12) : "?";
}

module.exports = {
  captureProjectSnapshot,
  compareProjectSnapshots,
  formatSnapshotSummary,
  listProjectContainers,
  inspectContainer,
  COMPARED_FIELDS,
};
