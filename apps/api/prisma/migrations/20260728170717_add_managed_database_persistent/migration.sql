-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ManagedDatabase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "username" TEXT,
    "password" TEXT,
    "databaseName" TEXT,
    "connectionString" TEXT,
    "envVarKey" TEXT,
    "persistent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ManagedDatabase_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ManagedDatabase" ("connectionString", "createdAt", "databaseName", "envVarKey", "id", "password", "projectId", "type", "username") SELECT "connectionString", "createdAt", "databaseName", "envVarKey", "id", "password", "projectId", "type", "username" FROM "ManagedDatabase";
DROP TABLE "ManagedDatabase";
ALTER TABLE "new_ManagedDatabase" RENAME TO "ManagedDatabase";
CREATE UNIQUE INDEX "ManagedDatabase_projectId_key" ON "ManagedDatabase"("projectId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
