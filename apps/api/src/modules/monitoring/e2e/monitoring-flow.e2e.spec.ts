import * as path from "node:path";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request from "supertest";
import type { SystemMetrics } from "@forgedesk/shared-types";

// Mesmo padrão dos outros e2e (auth, projects): SQLite temporário e
// descartável, nunca o dev.db real. O SYSTEM_METRICS_COLLECTOR de verdade
// chama docker ps/stats + powershell/df — aqui é substituído por um fake
// fixo, então o teste cobre a wiring HTTP + persistência real no banco
// (histórico, downsample, guard de auth), sem depender do ambiente real
// de containers/SO rodando a máquina de teste.
jest.setTimeout(30_000);

const PRISMA_DIR = path.join(__dirname, "../../../../prisma");
const dbFileName = `.e2e-monitoring-${crypto.randomUUID()}.db`;
const dbPath = path.join(PRISMA_DIR, dbFileName);
const databaseUrl = `file:./${dbFileName}`;

const FAKE_METRICS: SystemMetrics = {
  cpuPercent: 42,
  totalMemMb: 16000,
  freeMemMb: 8000,
  usedMemPercent: 50,
  diskTotalGb: 500,
  diskFreeGb: 200,
  usedDiskPercent: 60,
  uptimeSeconds: 3600,
  tier: "medium",
  containers: [{ name: "fake-container", status: "Up 1 hour", memUsageMb: 128, cpuPercent: 3.5 }],
};

class FakeSystemMetricsCollector {
  async collect(): Promise<SystemMetrics> {
    return FAKE_METRICS;
  }
}

function extractCookie(setCookieHeader: string | string[] | undefined, name: string): string | null {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
  const line = headers.find((c) => c.startsWith(`${name}=`));
  if (!line) return null;
  return line.split(";")[0].split("=")[1];
}

describe("Monitoring flow (e2e)", () => {
  let app: INestApplication;
  let authCookie: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.JWT_SECRET = "e2e-test-secret-not-for-production-use";
    process.env.JWT_EXPIRES_IN = "15m";

    const prismaCli = require.resolve("prisma/build/index.js");
    execFileSync(process.execPath, [prismaCli, "db", "push", "--skip-generate"], {
      cwd: path.join(__dirname, "../../../.."),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    });

    const { MonitoringModule } = require("../monitoring.module");
    const { AuthModule } = require("../../auth/auth.module");
    const { SYSTEM_METRICS_COLLECTOR } = require("../domain/system-metrics-collector");

    // Precisa do AuthModule na árvore igual ao app real (app.module.ts): o
    // guard global (APP_GUARD) é registrado dentro do AuthModule, não do
    // MonitoringModule — sem ele, os endpoints ficariam abertos no teste
    // mesmo sendo protegidos na aplicação de verdade.
    const moduleFixture = await Test.createTestingModule({ imports: [AuthModule, MonitoringModule] })
      .overrideProvider(SYSTEM_METRICS_COLLECTOR)
      .useValue(new FakeSystemMetricsCollector())
      .compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    await app.init();

    const register = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email: "admin@e2e-monitoring.local", password: "senha-super-forte-123" });
    authCookie = extractCookie(register.headers["set-cookie"], "forgedesk_token")!;
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-journal`, { force: true });
  });

  function authCookieHeader(): string {
    return `forgedesk_token=${authCookie}`;
  }

  it("rejeita /monitoring/system sem autenticação", async () => {
    const res = await request(app.getHttpServer()).get("/monitoring/system");
    expect(res.status).toBe(401);
  });

  it("retorna as métricas do sistema (via collector fake)", async () => {
    const res = await request(app.getHttpServer())
      .get("/monitoring/system")
      .set("Cookie", [authCookieHeader()]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(FAKE_METRICS);
  });

  it("histórico vazio antes de qualquer amostra", async () => {
    const res = await request(app.getHttpServer())
      .get("/monitoring/history?range=1h")
      .set("Cookie", [authCookieHeader()]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  describe("com amostras persistidas", () => {
    beforeAll(async () => {
      const { PrismaService } = require("../../../infrastructure/prisma/prisma.service");
      const prisma = new PrismaService();
      await prisma.$connect();

      const now = Date.now();
      const samples = Array.from({ length: 5 }, (_, i) => ({
        id: crypto.randomUUID(),
        cpuPercent: 10 + i,
        usedMemPercent: 40 + i,
        usedDiskPercent: 60,
        capturedAt: new Date(now - (5 - i) * 60_000),
      }));
      await prisma.metricSample.createMany({ data: samples });
      await prisma.$disconnect();
    });

    it("retorna as amostras no range de 1h", async () => {
      const res = await request(app.getHttpServer())
        .get("/monitoring/history?range=1h")
        .set("Cookie", [authCookieHeader()]);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(5);
      expect(res.body[0].cpuPercent).toBe(10);
    });

    it("range inválido cai pro fallback de 1h (mesmas amostras)", async () => {
      const res = await request(app.getHttpServer())
        .get("/monitoring/history?range=bagunça")
        .set("Cookie", [authCookieHeader()]);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(5);
    });

    it("range de 7d também inclui as mesmas amostras (janela maior)", async () => {
      const res = await request(app.getHttpServer())
        .get("/monitoring/history?range=7d")
        .set("Cookie", [authCookieHeader()]);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(5);
    });
  });

  it("o coletor em background persiste uma amostra real quando disparado manualmente", async () => {
    const recordUseCase = app.get(require("../application/record-metric-sample.use-case").RecordMetricSampleUseCase);
    await recordUseCase.execute();

    const res = await request(app.getHttpServer())
      .get("/monitoring/history?range=1h")
      .set("Cookie", [authCookieHeader()]);
    // as 5 semeadas manualmente + 1 gravada agora pelo use case real (usando
    // o collector fake por baixo, mas passando pelo caminho de persistência
    // de verdade: MetricSample.create + repository.save via Prisma).
    expect(res.body.length).toBeGreaterThanOrEqual(6);
    const latest = res.body[res.body.length - 1];
    expect(latest.cpuPercent).toBe(FAKE_METRICS.cpuPercent);
  });
});
