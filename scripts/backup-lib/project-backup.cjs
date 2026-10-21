"use strict";

/**
 * BACKUP DOS BANCOS GERENCIADOS POR PROJETO.
 *
 * O cron (apps/api/scripts/backup.js) e qualquer outro chamador passam
 * a lista de projetos (objetos simples) e recebem:
 * - `failures`: lista de falhas (uma por projeto/banco) - é o que o cron
 *   transforma em alerta;
 * - `results`: detalhe de cada dump (ok, bytes, sha256...).
 *
 * Nada aqui engole erro: falha de dump e falha de cópia de uploads
 * entram em `failures`.
 */

const path = require("node:path");

const { dumpDatabase, dumpUploads } = require("./dump.cjs");

const EXTENSION_BY_TYPE = {
  postgres: "sql",
  mongodb: "archive",
  redis: "rdb",
};

/**
 * @param {object[]} projects  [{ id, name, containerName, managedDatabases: [...] }]
 * @param {object} options
 * @param {string} options.destDir
 * @param {string} [options.backupRoot]
 * @param {string} [options.reason]
 * @param {boolean} [options.includeUploads]
 * @returns {Promise<{failures: string[], results: object[]}>}
 */
async function backupProjects(projects, options) {
  const {
    destDir,
    backupRoot = null,
    reason = "cron",
    includeUploads = true,
    runProcess = undefined,
    onLog = () => {},
  } = options || {};

  const failures = [];
  const results = [];

  for (const project of projects || []) {
    const safeName = String(project.name || "").replace(/[^a-z0-9-]+/gi, "-");

    if (includeUploads && project.containerName) {
      try {
        const uploads = await dumpUploads({
          containerName: project.containerName,
          outDir: path.join(destDir, `${safeName}-uploads`),
          runProcess,
          onLog,
        });
        if (!uploads.ok) {
          throw new Error(uploads.error || "Falha ao copiar os uploads do projeto.");
        }
        results.push({ projectId: project.id, kind: "uploads", ok: true, skipped: uploads.skipped });
      } catch (error) {
        onLog(`Falha ao fazer backup dos uploads de "${project.name}": ${error.message}`);
        failures.push(`${project.name} (uploads): ${error.message}`);
        results.push({ projectId: project.id, kind: "uploads", ok: false, error: error.message });
      }
    }

    if (!project.containerName) continue;

    // Um projeto pode ter mais de um banco gerenciado (ex.: Postgres +
    // Redis) - cada um com o próprio serviceName/container.
    for (const db of project.managedDatabases || []) {
      if (db.type === "custom") continue;

      const extension = EXTENSION_BY_TYPE[db.type];
      if (!extension) continue;

      if (db.type === "redis" && !db.persistent) {
        onLog(`${project.name} (Redis): pulado (marcado como cache/fila, sem persistência).`);
        results.push({ projectId: project.id, kind: "redis", ok: true, skipped: true });
        continue;
      }

      const containerName = `${project.containerName}-${db.serviceName}-1`;
      const outFile = path.join(destDir, `${safeName}-${db.type}.${extension}`);

      try {
        const result = await dumpDatabase({
          dbType: db.type,
          containerName,
          username: db.username,
          password: db.password,
          databaseName: db.databaseName,
          outFile,
          reason,
          projectId: project.id,
          serviceName: db.serviceName,
          backupRoot,
          runProcess,
          onLog,
        });

        if (!result.ok) {
          throw new Error(result.error || "Falha ao fazer dump do banco.");
        }
        results.push({
          projectId: project.id,
          kind: db.type,
          ok: true,
          outFile,
          bytes: result.bytes,
          sha256: result.sha256,
        });
      } catch (error) {
        onLog(`Falha ao fazer backup de "${project.name}" (${db.type}): ${error.message}`);
        failures.push(`${project.name} (${db.type}): ${error.message}`);
        results.push({ projectId: project.id, kind: db.type, ok: false, error: error.message });
      }
    }
  }

  return { failures, results };
}

module.exports = {
  backupProjects,
  EXTENSION_BY_TYPE,
};
