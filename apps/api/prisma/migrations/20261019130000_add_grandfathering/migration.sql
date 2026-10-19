-- Wave 2.1: grandfathering.
--
-- Projetos que já rodam na VPS (ex.: Mesatta, Evolution API) continuam com o
-- limite de memória, a imagem e a política de restart que JÁ têm. Estes
-- campos apenas REGISTRAM o estado observado no Docker (reconciliação
-- somente leitura) - nada aqui altera container, volume, rede ou porta.
--
-- ATENÇÃO: migration NÃO executada em nenhum ambiente. Em produção:
--   cd apps/api && npx prisma migrate deploy

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "productionMemoryLimitMb" INTEGER;
ALTER TABLE "Project" ADD COLUMN "runtimeSnapshot" TEXT;
ALTER TABLE "Project" ADD COLUMN "grandfathered" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Project" ADD COLUMN "grandfatheredAt" DATETIME;
ALTER TABLE "Project" ADD COLUMN "runtimeDriftDetected" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Project" ADD COLUMN "runtimeDriftDetails" TEXT;
ALTER TABLE "Project" ADD COLUMN "memoryLimitReductionApproved" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ManagedDatabase" ADD COLUMN "memoryLimitMb" INTEGER;
