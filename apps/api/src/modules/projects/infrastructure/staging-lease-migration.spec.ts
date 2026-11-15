import * as fs from "node:fs";
import * as path from "node:path";

describe("migration add_staging_port_leases", () => {
  const migrationPath = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "prisma",
    "migrations",
    "20261115180000_add_staging_port_leases",
    "migration.sql",
  );

  it("cria a tabela de lease, unique de porta e índices", () => {
    const sql = fs.readFileSync(migrationPath, "utf-8");
    expect(sql).toContain('CREATE TABLE "StagingPortLease"');
    expect(sql).toContain('CREATE UNIQUE INDEX "StagingPortLease_portKey_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "StagingPortLease_projectId_runId_key"');
    expect(sql).toContain('CREATE INDEX "StagingPortLease_status_expiresAt_idx"');
  });

  it("é aditiva e preserva Project e tabelas anteriores", () => {
    const sql = fs.readFileSync(migrationPath, "utf-8").toUpperCase();
    expect(sql).not.toContain("DROP TABLE");
    expect(sql).not.toContain('ALTER TABLE "PROJECT"');
    expect(sql).not.toContain("DELETE FROM");
    expect(sql).not.toContain("TRUNCATE");
    expect(sql).not.toContain('"PROJECTSTAGINGCONFIG"');
    expect(sql).not.toContain('"STAGINGSECRET"');
  });

  it("mantém cascade de projeto e exclusão segura", () => {
    const sql = fs.readFileSync(migrationPath, "utf-8");
    expect(sql).toContain('FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE');
    expect(sql).toContain('"portKey" TEXT');
    expect(sql).toContain('"status" TEXT NOT NULL');
  });
});
