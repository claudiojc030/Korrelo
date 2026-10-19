-- Fila global de deploy (Wave 2) + separação entre status de runtime e
-- status do último deploy + imagens versionadas para rollback.
--
-- ATENÇÃO: esta migration NÃO foi executada em nenhum ambiente. Em produção
-- ela precisa ser aplicada com:
--   cd apps/api && npx prisma migrate deploy
-- (ou o botão "Atualizar agora" do painel, que roda exatamente esse
-- comando no self-update.sh).

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "lastDeployStatus" TEXT;
ALTER TABLE "Project" ADD COLUMN "currentImage" TEXT;
ALTER TABLE "Project" ADD COLUMN "previousImage" TEXT;
ALTER TABLE "Project" ADD COLUMN "healthcheckConfig" TEXT;

-- CreateTable
CREATE TABLE "DeployJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "commitSha" TEXT,
    "branch" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "stage" TEXT,
    "errorMessage" TEXT,
    "log" TEXT NOT NULL DEFAULT '',
    "previousImage" TEXT,
    "candidateImage" TEXT,
    "rollbackAttempted" BOOLEAN NOT NULL DEFAULT false,
    "rollbackSucceeded" BOOLEAN NOT NULL DEFAULT false,
    "imageTag" TEXT,
    "buildDurationMs" INTEGER,
    "deployDurationMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "DeployJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "DeployJob_projectId_commitSha_key" ON "DeployJob"("projectId", "commitSha");
CREATE INDEX "DeployJob_status_createdAt_idx" ON "DeployJob"("status", "createdAt");
