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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ManagedDatabase_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ManagedDatabase" ("createdAt", "databaseName", "id", "password", "projectId", "type", "username") SELECT "createdAt", "databaseName", "id", "password", "projectId", "type", "username" FROM "ManagedDatabase";
DROP TABLE "ManagedDatabase";
ALTER TABLE "new_ManagedDatabase" RENAME TO "ManagedDatabase";
CREATE UNIQUE INDEX "ManagedDatabase_projectId_key" ON "ManagedDatabase"("projectId");
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "repoUrl" TEXT NOT NULL,
    "detectedStack" TEXT,
    "status" TEXT NOT NULL DEFAULT 'detected',
    "assignedPort" INTEGER,
    "containerName" TEXT,
    "terminalEnabled" BOOLEAN NOT NULL DEFAULT true,
    "databaseEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Project" ("assignedPort", "containerName", "createdAt", "detectedStack", "id", "name", "repoUrl", "status") SELECT "assignedPort", "containerName", "createdAt", "detectedStack", "id", "name", "repoUrl", "status" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
