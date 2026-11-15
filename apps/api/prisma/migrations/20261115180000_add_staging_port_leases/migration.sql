-- P1B2 — LEASE INTERNO DE PORTA/RECURSOS.
--
-- Aditivo: nenhuma coluna de "Project" é alterada, nenhum backfill e nenhum
-- projeto recebe lease. A unique constraint em "portKey" é a garantia real
-- contra duas reservas ativas da mesma porta no banco do Core.
-- A sonda TCP não é uma reserva atômica do sistema operacional.
--
-- Em produção: cd apps/api && npx prisma migrate deploy

CREATE TABLE "StagingPortLease" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "hostPort" INTEGER NOT NULL,
    "portKey" TEXT,
    "status" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "memoryMb" INTEGER NOT NULL,
    "cpu" REAL NOT NULL,
    "diskMb" INTEGER NOT NULL,
    "ownerId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "releasedAt" DATETIME,
    CONSTRAINT "StagingPortLease_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "StagingPortLease_portKey_key" ON "StagingPortLease"("portKey");
CREATE UNIQUE INDEX "StagingPortLease_projectId_runId_key" ON "StagingPortLease"("projectId", "runId");
CREATE INDEX "StagingPortLease_status_expiresAt_idx" ON "StagingPortLease"("status", "expiresAt");
