import { BadRequestException, Injectable } from "@nestjs/common";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { DatabaseQueryResult, DatabaseQueryRunner } from "../domain/database-query-runner";
import type { ManagedDatabase } from "../domain/managed-database.entity";
import { parseCsv } from "./csv-parser";

const execFile = promisify(execFileCallback);
const QUERY_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 500;

function tokenizeShellLike(input: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

@Injectable()
export class DockerExecDatabaseQueryRunner implements DatabaseQueryRunner {
  async listTables(containerName: string, database: ManagedDatabase): Promise<string[]> {
    if (database.type === "postgres") {
      const result = await this.runPostgresQuery(
        containerName,
        database,
        "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY tablename;",
      );
      return result.rows.map((row) => row[0]);
    }

    if (database.type === "mongodb") {
      const stdout = await this.runMongoEval(containerName, database, "print(JSON.stringify(db.getCollectionNames()))");
      return JSON.parse(stdout) as string[];
    }

    if (database.type === "redis") {
      const { stdout } = await this.execDocker(containerName, [
        "redis-cli",
        "-a",
        database.password ?? "",
        "--no-auth-warning",
        "--scan",
        "--count",
        "200",
      ]);
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 200);
    }

    throw new BadRequestException("Bancos externos (custom) não têm navegador — conecte com sua própria ferramenta.");
  }

  async runQuery(containerName: string, database: ManagedDatabase, query: string): Promise<DatabaseQueryResult> {
    const trimmed = query.trim();
    if (!trimmed) {
      throw new BadRequestException("Informe uma query.");
    }

    if (database.type === "postgres") {
      return this.runPostgresQuery(containerName, database, trimmed);
    }
    if (database.type === "mongodb") {
      return this.runMongoQuery(containerName, database, trimmed);
    }
    if (database.type === "redis") {
      return this.runRedisCommand(containerName, database, trimmed);
    }

    throw new BadRequestException("Bancos externos (custom) não têm console de query — conecte com sua própria ferramenta.");
  }

  private async execDocker(
    containerName: string,
    args: string[],
    env: Record<string, string> = {},
  ): Promise<{ stdout: string; stderr: string }> {
    const envFlags = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    try {
      return await execFile("docker", ["exec", ...envFlags, containerName, ...args], {
        timeout: QUERY_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
      });
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message: string };
      const detail = [err.stderr, err.stdout].filter(Boolean).join("\n").trim() || err.message;
      throw new BadRequestException(detail.slice(0, 4000));
    }
  }

  private async runPostgresQuery(
    containerName: string,
    database: ManagedDatabase,
    query: string,
  ): Promise<DatabaseQueryResult> {
    const { stdout } = await this.execDocker(
      containerName,
      [
        "psql",
        "-U",
        database.username ?? "forgedesk",
        "-d",
        database.databaseName ?? "forgedesk",
        "-v",
        "ON_ERROR_STOP=1",
        "--csv",
        "--no-psqlrc",
        "-c",
        query,
      ],
      { PGPASSWORD: database.password ?? "" },
    );

    return this.parsePsqlOutput(stdout);
  }

  private parsePsqlOutput(stdout: string): DatabaseQueryResult {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { columns: [], rows: [], rowCount: 0, notice: "Comando executado (sem resultado)." };
    }

    const hasMultipleLines = trimmed.includes("\n");
    const firstLine = trimmed.split("\n")[0];
    const looksTabular = hasMultipleLines || firstLine.includes(",");

    if (!looksTabular) {
      return { columns: [], rows: [], rowCount: 0, notice: trimmed };
    }

    const { header, rows } = parseCsv(trimmed);
    const limitedRows = rows.slice(0, MAX_ROWS);
    return {
      columns: header,
      rows: limitedRows,
      rowCount: rows.length,
      notice: rows.length > MAX_ROWS ? `Mostrando as primeiras ${MAX_ROWS} linhas de ${rows.length}.` : null,
    };
  }

  private async runMongoEval(containerName: string, database: ManagedDatabase, evalScript: string): Promise<string> {
    const uri = `mongodb://${database.username}:${database.password}@localhost:27017/${database.databaseName}?authSource=admin`;
    const { stdout } = await this.execDocker(containerName, ["mongosh", uri, "--quiet", "--eval", evalScript]);
    return stdout.trim();
  }

  private async runMongoQuery(
    containerName: string,
    database: ManagedDatabase,
    query: string,
  ): Promise<DatabaseQueryResult> {
    const evalScript = `print(JSON.stringify((function(){ return (${query}); })()))`;
    const stdout = await this.runMongoEval(containerName, database, evalScript);

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return { columns: [], rows: [], rowCount: 0, notice: stdout || "Comando executado (sem resultado)." };
    }

    const documents = Array.isArray(parsed) ? parsed : [parsed];
    if (documents.length === 0) {
      return { columns: [], rows: [], rowCount: 0, notice: "Nenhum documento encontrado." };
    }

    const columnSet = new Set<string>();
    for (const doc of documents) {
      if (doc && typeof doc === "object") {
        Object.keys(doc as Record<string, unknown>).forEach((key) => columnSet.add(key));
      }
    }
    const columns = columnSet.size > 0 ? Array.from(columnSet) : ["value"];

    const rows = documents.slice(0, MAX_ROWS).map((doc) => {
      if (!doc || typeof doc !== "object") {
        return columns.map((col) => (col === "value" ? String(doc) : ""));
      }
      const record = doc as Record<string, unknown>;
      return columns.map((col) => {
        const value = record[col];
        if (value === undefined) return "";
        return typeof value === "string" ? value : JSON.stringify(value);
      });
    });

    return {
      columns,
      rows,
      rowCount: documents.length,
      notice: documents.length > MAX_ROWS ? `Mostrando os primeiros ${MAX_ROWS} documentos de ${documents.length}.` : null,
    };
  }

  private async runRedisCommand(
    containerName: string,
    database: ManagedDatabase,
    command: string,
  ): Promise<DatabaseQueryResult> {
    const args = tokenizeShellLike(command);
    if (args.length === 0) {
      throw new BadRequestException("Comando Redis vazio.");
    }

    const { stdout } = await this.execDocker(containerName, [
      "redis-cli",
      "-a",
      database.password ?? "",
      "--no-auth-warning",
      ...args,
    ]);

    const lines = stdout.split("\n").filter((line, index, arr) => line.length > 0 || index < arr.length - 1);
    if (lines.length === 0) {
      return { columns: [], rows: [], rowCount: 0, notice: "(sem retorno)" };
    }

    return {
      columns: ["resultado"],
      rows: lines.slice(0, MAX_ROWS).map((line) => [line]),
      rowCount: lines.length,
      notice: null,
    };
  }
}
