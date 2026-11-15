-- P1B3 — STAGING RUN E COORDENADOR DE CAPACIDADE.
--
-- Aditivo: nenhuma coluna obrigatória em Project, nenhum backfill e nenhum
-- registro criado para projetos existentes.
-- StagingRun é a fonte persistida de ownership; labels são complementares,
-- nunca autorização isolada para exclusão.
--
-- Em produção: cd apps/api && npx prisma migrate deploy

CREATE TABLE "StagingRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "deployJobId" TEXT,
    "runId" TEXT NOT NULL,
    "composeProject" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "planHash" TEXT NOT NULL,
    "composeHash" TEXT NOT NULL,
    "imageReference" TEXT,
    "imageId" TEXT,
    "imageDigest" TEXT,
    "memoryMb" INTEGER NOT NULL,
    "cpu" REAL NOT NULL,
    "diskMb" INTEGER NOT NULL,
    "leaseId" TEXT NOT NULL,
    "networkName" TEXT,
    "volumePrefix" TEXT,
    "ownerId" TEXT,
    "cleanupState" TEXT NOT NULL DEFAULT 'none',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "StagingRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StagingRun_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "StagingPortLease" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "StagingRun_leaseId_key" ON "StagingRun"("leaseId");
CREATE UNIQUE INDEX "StagingRun_projectId_runId_key" ON "StagingRun"("projectId", "runId");
CREATE INDEX "StagingRun_status_expiresAt_idx" ON "StagingRun"("status", "expiresAt");

CREATE TABLE "StagingCoordinator" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

INSERT INTO "StagingCoordinator" ("id", "version", "updatedAt") VALUES ('global', 0, CURRENT_TIMESTAMP);
