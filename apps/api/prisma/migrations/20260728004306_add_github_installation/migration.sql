-- CreateTable
CREATE TABLE "GithubInstallation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "installationId" INTEGER NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "GithubInstallation_installationId_key" ON "GithubInstallation"("installationId");
