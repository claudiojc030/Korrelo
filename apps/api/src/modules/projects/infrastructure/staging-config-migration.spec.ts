import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A migration P1B1 precisa continuar estritamente aditiva.
 * A compatibilidade com SQLite é exercitada pelo repositório, que cria o
 * schema com `prisma db push` em banco temporário.
 */
describe("migration add_staging_config", () => {
  const migrationPath = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "prisma",
    "migrations",
    "20261115120000_add_staging_config",
    "migration.sql",
  );

  it("cria somente as tabelas da configuração, dependências e segredos", () => {
    const sql = fs.readFileSync(migrationPath, "utf-8");
    expect(sql).toContain('CREATE TABLE "ProjectStagingConfig"');
    expect(sql).toContain('CREATE TABLE "StagingDependency"');
    expect(sql).toContain('CREATE TABLE "StagingSecret"');
    expect(sql).toContain('CREATE UNIQUE INDEX "ProjectStagingConfig_projectId_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "StagingDependency_configId_name_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "StagingSecret_projectId_key_key"');
    expect(sql).not.toContain('CREATE TABLE "StagingRun"');
    expect(sql).not.toContain('CREATE TABLE "StagingPortLease"');
  });

  it("não altera a tabela Project nem usa operações destrutivas", () => {
    const sql = fs.readFileSync(migrationPath, "utf-8").toUpperCase();
    expect(sql).not.toContain("DROP TABLE");
    expect(sql).not.toContain('ALTER TABLE "PROJECT"');
    expect(sql).not.toContain("DELETE FROM");
    expect(sql).not.toContain("TRUNCATE");
  });

  it("mantém integridade por projeto e exclusão segura", () => {
    const sql = fs.readFileSync(migrationPath, "utf-8");
    expect(sql).toContain('FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE');
    expect(sql).toContain('FOREIGN KEY ("configId") REFERENCES "ProjectStagingConfig" ("id") ON DELETE CASCADE');
    expect(sql).toContain('FOREIGN KEY ("externalSecretId") REFERENCES "StagingSecret" ("id") ON DELETE SET NULL');
  });
});
