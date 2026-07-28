-- CreateTable
CREATE TABLE "MetricSample" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cpuPercent" REAL NOT NULL,
    "usedMemPercent" REAL NOT NULL,
    "usedDiskPercent" REAL NOT NULL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "MetricSample_capturedAt_idx" ON "MetricSample"("capturedAt");
