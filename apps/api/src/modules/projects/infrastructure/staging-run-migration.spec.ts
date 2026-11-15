import * as fs from "node:fs";
import * as path from "node:path";

describe("migration add_staging_runs", () => {
  const migrationPath = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "prisma",
    "migrations",
    "20261115200000_add_staging_runs",
    "migration.sql",
  );

  it("cria StagingRun e o coordenador de capacidade", () => {
    const sql = fs.readFileSync(migrationPath, "utf-8");
    expect(sql).toContain('CREATE TABLE "StagingRun"');
    expect(sql).toContain('CREATE TABLE "StagingCoordinator"');
    expect(sql).toContain('CREATE UNIQUE INDEX "StagingRun_leaseId_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "StagingRun_projectId_runId_key"');
    expect(sql).toContain('CREATE INDEX "StagingRun_status_expiresAt_idx"');
  });

  it("é aditiva e não altera Project nem tabelas anteriores", () => {
    const sql = fs.readFileSync(migrationPath, "utf-8").toUpperCase();
    expect(sql).not.toContain("DROP TABLE");
    expect(sql).not.toContain('ALTER TABLE "PROJECT"');
    expect(sql).not.toContain("DELETE FROM");
    expect(sql).not.toContain("TRUNCATE");
    expect(sql).not.toContain('"PROJECTSTAGINGCONFIG"');
    expect(sql).not.toContain('CREATE TABLE "STAGINGPORTLEASE"');
  });

  it("mantém ownership e exclusão segura", () => {
    const sql = fs.readFileSync(migrationPath, "utf-8");
    expect(sql).toContain('FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE');
    expect(sql).toContain('FOREIGN KEY ("leaseId") REFERENCES "StagingPortLease" ("id") ON DELETE CASCADE');
    expect(sql).toContain('"cleanupState" TEXT NOT NULL DEFAULT');
  });
});
