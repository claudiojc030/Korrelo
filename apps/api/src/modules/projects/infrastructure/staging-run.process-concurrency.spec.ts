import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const PRISMA_DIR = path.join(__dirname, "../../../../prisma");
jest.setTimeout(60_000);
const dbFileName = `.p1b3-process-${crypto.randomUUID()}.db`;
const dbPath = path.join(PRISMA_DIR, dbFileName);
const databaseUrl = `file:${dbPath.replace(/\\/g, "/")}`;
const apiRoot = path.join(__dirname, "../../../..");
const workerDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "korrelo-p1b3-worker-"));
const workerPath = path.join(workerDir, "worker.js");

/**
 * Exercita o código REAL do repositório em dois processos Node independentes,
 * usando o mesmo SQLite e conexões Prisma independentes.
 */
describe("P1B3 concorrência entre processos independentes", () => {
  let prisma: PrismaClient;
  let projectId: string;
  const previousDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    const prismaCli = require.resolve("prisma/build/index.js");
    execFileSync(process.execPath, [prismaCli, "db", "push", "--skip-generate"], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    });
    prisma = new PrismaClient();
    await prisma.$connect();
    const project = await prisma.project.create({
      data: { name: "Process Concurrency", repoUrl: "https://example.com/process.git" },
    });
    projectId = project.id;

    const runRepo = path.join(
      apiRoot,
      "src/modules/projects/infrastructure/prisma-staging-run.repository.ts",
    );
    const leaseRepo = path.join(
      apiRoot,
      "src/modules/projects/infrastructure/prisma-staging-port-lease.repository.ts",
    );
    const capacityService = path.join(
      apiRoot,
      "src/modules/projects/application/staging-capacity.service.ts",
    );
    const tsNodeRegister = require.resolve("ts-node/register/transpile-only");
    const prismaClientPath = require.resolve("@prisma/client");
    const tsConfig = path.join(apiRoot, "tsconfig.json");
    fs.writeFileSync(
      workerPath,
      [
        `const { PrismaClient } = require(${JSON.stringify(prismaClientPath)});`,
        `const { PrismaStagingRunRepository } = require(${JSON.stringify(runRepo)});`,
        `const { PrismaStagingPortLeaseRepository } = require(${JSON.stringify(leaseRepo)});`,
        `const { StagingCapacityService } = require(${JSON.stringify(capacityService)});`,
        `const [projectId, runId, portArg] = process.argv.slice(2);`,
        `const port = Number(portArg);`,
        `(async () => {`,
        `  const prisma = new PrismaClient();`,
        `  const leases = new PrismaStagingPortLeaseRepository(prisma);`,
        `  const host = { read: async () => ({ availableCpu: 8, availableMemoryMb: 700, freeDiskMb: 20000 }) };`,
        `  const probe = { findUnavailable: async () => [] };`,
        `  const capacity = new StagingCapacityService(leases, host);`,
        `  const runs = new PrismaStagingRunRepository(prisma, capacity, host, probe);`,
        `  const result = await runs.reserve({`,
        `    projectId, runId, deployJobId: "job-process",`,
        `    composeProject: "korrelo-stg-" + runId,`,
        `    planHash: "a".repeat(64), composeHash: "b".repeat(64),`,
        `    app: { memoryMb: 512, cpu: 0.5, diskMb: 1024 }, dependencies: [],`,
        `    portCandidates: [port], ttlMinutes: 30,`,
        `    policy: { maxConcurrentEnvironments: 2, maxTtlMinutes: 60, productionReservedMemoryMb: 0, productionReservedCpu: 0, productionReservedDiskMb: 0, safetyMemoryMb: 0, safetyCpu: 0, safetyDiskMb: 0 },`,
        `  });`,
        `  console.log(JSON.stringify({ ok: result.ok, issues: result.issues.map((issue) => issue.code), leaseId: result.lease?.id ?? null, runId: result.run?.runId ?? null }));`,
        `  await prisma.$disconnect();`,
        `})().catch((error) => { console.error(error?.message ?? String(error)); process.exit(1); });`,
      ].join("\n"),
      "utf-8",
    );
    process.env.P1B3_TS_NODE_REGISTER = tsNodeRegister;
    process.env.P1B3_TS_CONFIG = tsConfig;
    process.env.P1B3_WORKER = workerPath;
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-journal`, { force: true });
    fs.rmSync(workerDir, { recursive: true, force: true });
    delete process.env.P1B3_TS_NODE_REGISTER;
    delete process.env.P1B3_TS_CONFIG;
    delete process.env.P1B3_WORKER;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it("apenas um processo confirma a reserva e o estado final é consistente", async () => {
    const tsNodeRegister = process.env.P1B3_TS_NODE_REGISTER!;
    const tsConfig = process.env.P1B3_TS_CONFIG!;
    const worker = process.env.P1B3_WORKER!;
    const env = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      TS_NODE_PROJECT: tsConfig,
      TS_NODE_TRANSPILE_ONLY: "true",
    };

    const children = [
      spawn(process.execPath, ["-r", tsNodeRegister, worker, projectId, "process-a", "4500"], {
        cwd: apiRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }),
      spawn(process.execPath, ["-r", tsNodeRegister, worker, projectId, "process-b", "4501"], {
        cwd: apiRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ];

    const outputs = await Promise.all(
      children.map(
        (child) =>
          new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (chunk) => (stdout += String(chunk)));
            child.stderr.on("data", (chunk) => (stderr += String(chunk)));
            child.on("close", (code) => resolve({ code, stdout, stderr }));
          }),
      ),
    );

    const results = outputs.map((out) => {
      const line = out.stdout.trim().split("\n").filter(Boolean).at(-1);
      if (!line) throw new Error(`worker sem saída JSON: ${out.stderr}`);
      return JSON.parse(line) as { ok: boolean; issues: string[]; leaseId: string | null; runId: string | null };
    });

    if (results.filter((result) => result.ok).length !== 1) {
      throw new Error(`estado inesperado dos workers: ${JSON.stringify(outputs)}`);
    }
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const failed = results.filter((result) => !result.ok)[0];
    expect(failed.issues.length).toBeGreaterThan(0);
    expect(
      failed.issues.some(
        (code) =>
          code.startsWith("STAGING_CAPACITY_") ||
          code === "STAGING_RUN_DB_ERROR" ||
          code === "STAGING_RUN_PORT_UNAVAILABLE",
      ),
    ).toBe(true);

    const runCount = await prisma.stagingRun.count();
    const leaseCount = await prisma.stagingPortLease.count();
    const activeLeaseCount = await prisma.stagingPortLease.count({ where: { portKey: { not: null } } });
    expect(runCount).toBe(1);
    expect(leaseCount).toBe(1);
    expect(activeLeaseCount).toBe(1);

    const run = await prisma.stagingRun.findFirst();
    const lease = await prisma.stagingPortLease.findFirst();
    expect(run?.leaseId).toBe(lease?.id);
    expect(lease?.portKey).toBe(`port:${lease?.hostPort}`);
  }, 30_000);
});
