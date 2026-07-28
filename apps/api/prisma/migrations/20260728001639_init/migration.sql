-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "repoUrl" TEXT NOT NULL,
    "detectedStack" TEXT,
    "status" TEXT NOT NULL DEFAULT 'detected',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
