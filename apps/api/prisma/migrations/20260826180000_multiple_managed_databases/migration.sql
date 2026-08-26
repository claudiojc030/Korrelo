-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ManagedDatabase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "serviceName" TEXT,
    "username" TEXT,
    "password" TEXT,
    "databaseName" TEXT,
    "connectionString" TEXT,
    "envVarKey" TEXT,
    "persistent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ManagedDatabase_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- Todo banco existente até aqui era único por projeto (a constraint antiga
-- garantia isso) e já rodava como serviço "db" no compose - preenche esse
-- valor pra manter a connection string de todo projeto já implantado
-- funcionando sem precisar de redeploy.
INSERT INTO "new_ManagedDatabase" ("connectionString", "createdAt", "databaseName", "envVarKey", "id", "password", "projectId", "type", "username", "persistent", "serviceName")
SELECT "connectionString", "createdAt", "databaseName", "envVarKey", "id", "password", "projectId", "type", "username", "persistent",
  CASE WHEN "type" != 'custom' THEN 'db' ELSE NULL END
FROM "ManagedDatabase";
DROP TABLE "ManagedDatabase";
ALTER TABLE "new_ManagedDatabase" RENAME TO "ManagedDatabase";
CREATE UNIQUE INDEX "ManagedDatabase_projectId_type_key" ON "ManagedDatabase"("projectId", "type");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
