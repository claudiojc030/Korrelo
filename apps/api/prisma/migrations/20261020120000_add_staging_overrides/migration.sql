-- Configuração de STAGING POR PROJETO.
--
-- Um projeto pode precisar de mais (ou menos) memória no container de TESTE
-- do que o rateio automático dá. Ex.: o Mesatta em produção usa ~538 MB,
-- mas o build/staging precisa de mais folga pra o bootstrap do Next numa
-- VPS de 1 vCPU.
--
-- Estes campos são SÓ do staging:
--   - o limite de PRODUÇÃO (productionMemoryLimitMb) não é alterado;
--   - o limite do BANCO não é alterado;
--   - outros projetos não são afetados (o rateio automático global continua
--     valendo pra quem não configurar nada).
--
-- ATENÇÃO: migration NÃO executada em nenhum ambiente. Em produção:
--   cd apps/api && npx prisma migrate deploy

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "stagingMemoryLimitMb" INTEGER;
ALTER TABLE "Project" ADD COLUMN "stagingHealthTimeoutSeconds" INTEGER;
