-- P1B1 — PERSISTÊNCIA OPCIONAL DO STAGING ISOLADO.
--
-- Tabelas ESTRITAMENTE ADITIVAS. Nenhum projeto existente recebe linha,
-- nenhuma coluna de "Project" é alterada e não há backfill.
-- Ausência de "ProjectStagingConfig" = staging legado.
--
-- Segredos de staging ficam em tabela própria, cifrados pelo EnvVarCipher
-- (AES-256-GCM). O valor cifrado nunca é retornado em consultas comuns.
--
-- Em produção: cd apps/api && npx prisma migrate deploy

CREATE TABLE "ProjectStagingConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "ttlMinutes" INTEGER NOT NULL,
    "allowEgress" BOOLEAN NOT NULL DEFAULT false,
    "appMemoryMb" INTEGER NOT NULL,
    "appCpu" REAL NOT NULL,
    "appDiskMb" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectStagingConfig_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ProjectStagingConfig_projectId_key" ON "ProjectStagingConfig"("projectId");

CREATE TABLE "StagingSecret" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueCiphertext" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StagingSecret_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "StagingSecret_projectId_key_key" ON "StagingSecret"("projectId", "key");

CREATE TABLE "StagingDependency" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "configId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "envKey" TEXT,
    "targetScheme" TEXT,
    "targetHost" TEXT,
    "targetPort" INTEGER,
    "targetDatabase" TEXT,
    "memoryMb" INTEGER,
    "cpu" REAL,
    "diskMb" INTEGER,
    "externalSecretId" TEXT,
    "healthcheck" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StagingDependency_configId_fkey" FOREIGN KEY ("configId") REFERENCES "ProjectStagingConfig" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StagingDependency_externalSecretId_fkey" FOREIGN KEY ("externalSecretId") REFERENCES "StagingSecret" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "StagingDependency_configId_name_key" ON "StagingDependency"("configId", "name");
CREATE INDEX "StagingDependency_externalSecretId_idx" ON "StagingDependency"("externalSecretId");
