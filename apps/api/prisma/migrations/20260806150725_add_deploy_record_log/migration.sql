-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DeployRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "errorMessage" TEXT,
    "log" TEXT NOT NULL DEFAULT '',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "DeployRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_DeployRecord" ("errorMessage", "finishedAt", "id", "projectId", "startedAt", "status", "triggeredBy") SELECT "errorMessage", "finishedAt", "id", "projectId", "startedAt", "status", "triggeredBy" FROM "DeployRecord";
DROP TABLE "DeployRecord";
ALTER TABLE "new_DeployRecord" RENAME TO "DeployRecord";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
