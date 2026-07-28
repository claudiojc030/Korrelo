-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
    "customDomain" TEXT,
    "domainSslStatus" TEXT NOT NULL DEFAULT 'none',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Project" ("assignedPort", "containerName", "createdAt", "databaseEnabled", "detectedStack", "id", "name", "repoUrl", "status", "terminalEnabled") SELECT "assignedPort", "containerName", "createdAt", "databaseEnabled", "detectedStack", "id", "name", "repoUrl", "status", "terminalEnabled" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE UNIQUE INDEX "Project_customDomain_key" ON "Project"("customDomain");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
