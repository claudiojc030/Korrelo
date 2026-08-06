import * as path from "node:path";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as bcrypt from "bcryptjs";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request from "supertest";
import { AuthModule } from "../auth.module";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";

// Jest não consegue parsear a cadeia de dependências ESM do otplib
// (@scure/base, @noble/hashes) mesmo com overrides de transformIgnorePatterns
// (já tentado e revertido, ver histórico). Pra gerar um código TOTP válido
// aqui, implementamos o algoritmo (RFC 6238) direto com node:crypto, sem
// depender do otplib nesse arquivo de teste.
function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const char of cleaned) {
    const value = alphabet.indexOf(char);
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTotp(base32Secret: string, stepSeconds = 30, digits = 6): string {
  const key = base32Decode(base32Secret);
  const counter = Math.floor(Date.now() / 1000 / stepSeconds);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac("sha1", key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  const code = (binary % 10 ** digits).toString().padStart(digits, "0");
  return code;
}

// Testes de integração de verdade: sobem o AuthModule inteiro (Nest DI, guard
// global, Prisma) e batem nos endpoints HTTP via supertest, diferente dos
// specs de use-case isolado (que usam repositórios mockados na mão). Rodam
// contra um arquivo SQLite temporário e descartável, nunca contra o dev.db
// que tem dados reais do usuário.
jest.setTimeout(30_000);

const PRISMA_DIR = path.join(__dirname, "../../../../prisma");
const dbFileName = `.e2e-auth-${crypto.randomUUID()}.db`;
const dbPath = path.join(PRISMA_DIR, dbFileName);
const databaseUrl = `file:./${dbFileName}`;

function extractCookie(setCookieHeader: string | string[] | undefined, name: string): string | null {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
  const line = headers.find((c) => c.startsWith(`${name}=`));
  if (!line) return null;
  return line.split(";")[0].split("=")[1];
}

describe("Auth flow (e2e)", () => {
  let app: INestApplication;

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

    const moduleFixture = await Test.createTestingModule({ imports: [AuthModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-journal`, { force: true });
  });

  const username = "admin@e2e-test.local";
  const password = "senha-super-forte-123";

  it("has-user retorna false antes do registro", async () => {
    const res = await request(app.getHttpServer()).get("/auth/has-user");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasUser: false });
  });

  it("registra o primeiro usuário e seta os cookies de access+refresh", async () => {
    const res = await request(app.getHttpServer()).post("/auth/register").send({ username, password });

    expect(res.status).toBe(201);
    expect(res.body.username).toBe(username);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toBeUndefined();

    const accessCookie = extractCookie(res.headers["set-cookie"], "korrelo_token");
    const refreshCookie = extractCookie(res.headers["set-cookie"], "korrelo_refresh_token");
    expect(accessCookie).toBeTruthy();
    expect(refreshCookie).toBeTruthy();
  });

  it("recusa registrar uma segunda conta", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ username: "outro@e2e-test.local", password: "qualquer-coisa-123" });
    expect(res.status).toBe(409);
  });

  it("rejeita /auth/me sem cookie", async () => {
    const res = await request(app.getHttpServer()).get("/auth/me");
    expect(res.status).toBe(401);
  });

  it("rejeita login com senha errada", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username, password: "senha-errada" });
    expect(res.status).toBe(401);
  });

  describe("sessão via login + refresh token", () => {
    let accessCookie: string;
    let refreshCookie: string;

    it("loga com sucesso e recebe os dois cookies", async () => {
      const res = await request(app.getHttpServer()).post("/auth/login").send({ username, password });
      expect(res.status).toBe(201);
      expect(res.body.requiresTwoFactor).toBe(false);

      accessCookie = extractCookie(res.headers["set-cookie"], "korrelo_token")!;
      refreshCookie = extractCookie(res.headers["set-cookie"], "korrelo_refresh_token")!;
      expect(accessCookie).toBeTruthy();
      expect(refreshCookie).toBeTruthy();
    });

    it("/auth/me funciona com o access token", async () => {
      const res = await request(app.getHttpServer())
        .get("/auth/me")
        .set("Cookie", [`korrelo_token=${accessCookie}`]);
      expect(res.status).toBe(200);
      expect(res.body.username).toBe(username);
    });

    it("rotaciona o par de tokens via /auth/refresh e invalida o refresh token antigo", async () => {
      const oldRefreshCookie = refreshCookie;

      const res = await request(app.getHttpServer())
        .post("/auth/refresh")
        .set("Cookie", [`korrelo_refresh_token=${oldRefreshCookie}`]);

      expect(res.status).toBe(201);
      const newAccessCookie = extractCookie(res.headers["set-cookie"], "korrelo_token");
      const newRefreshCookie = extractCookie(res.headers["set-cookie"], "korrelo_refresh_token");
      expect(newAccessCookie).toBeTruthy();
      expect(newRefreshCookie).toBeTruthy();
      expect(newRefreshCookie).not.toBe(oldRefreshCookie);

      // reuso do refresh token antigo dentro da janela de graça (corrida de
      // requisições concorrentes) ganha só um access token novo, não é tratado
      // como token roubado - e não pisa no cookie de refresh que já é o certo.
      const reuse = await request(app.getHttpServer())
        .post("/auth/refresh")
        .set("Cookie", [`korrelo_refresh_token=${oldRefreshCookie}`]);
      expect(reuse.status).toBe(201);
      expect(extractCookie(reuse.headers["set-cookie"], "korrelo_token")).toBeTruthy();
      expect(extractCookie(reuse.headers["set-cookie"], "korrelo_refresh_token")).toBeNull();

      refreshCookie = newRefreshCookie!;
      accessCookie = newAccessCookie!;
    });

    it("logout revoga o refresh token no servidor", async () => {
      const logout = await request(app.getHttpServer())
        .post("/auth/logout")
        .set("Cookie", [`korrelo_refresh_token=${refreshCookie}`]);
      expect(logout.status).toBe(201);

      const refreshAfterLogout = await request(app.getHttpServer())
        .post("/auth/refresh")
        .set("Cookie", [`korrelo_refresh_token=${refreshCookie}`]);
      expect(refreshAfterLogout.status).toBe(401);
    });
  });

  describe("2FA (TOTP + backup codes)", () => {
    let accessCookie: string;
    let totpSecret: string;
    let backupCodes: string[];

    beforeAll(async () => {
      const login = await request(app.getHttpServer()).post("/auth/login").send({ username, password });
      accessCookie = extractCookie(login.headers["set-cookie"], "korrelo_token")!;
    });

    it("status inicial é desativado", async () => {
      const res = await request(app.getHttpServer())
        .get("/auth/2fa/status")
        .set("Cookie", [`korrelo_token=${accessCookie}`]);
      expect(res.body).toEqual({ enabled: false });
    });

    it("setup retorna secret + qrCodeDataUrl", async () => {
      const res = await request(app.getHttpServer())
        .post("/auth/2fa/setup")
        .set("Cookie", [`korrelo_token=${accessCookie}`]);
      expect(res.status).toBe(201);
      expect(res.body.secret).toEqual(expect.any(String));
      expect(res.body.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
      totpSecret = res.body.secret;
    });

    it("enable com código TOTP real ativa o 2FA e retorna backup codes", async () => {
      const code = generateTotp(totpSecret);
      const res = await request(app.getHttpServer())
        .post("/auth/2fa/enable")
        .set("Cookie", [`korrelo_token=${accessCookie}`])
        .send({ code });

      expect(res.status).toBe(201);
      expect(Array.isArray(res.body.backupCodes)).toBe(true);
      expect(res.body.backupCodes.length).toBeGreaterThan(0);
      backupCodes = res.body.backupCodes;
    });

    it("login sem código pede o segundo fator e não seta cookies", async () => {
      const res = await request(app.getHttpServer()).post("/auth/login").send({ username, password });
      expect(res.status).toBe(201);
      expect(res.body.requiresTwoFactor).toBe(true);
      expect(res.body.accessToken).toBeUndefined();
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("login com código TOTP válido funciona", async () => {
      const code = generateTotp(totpSecret);
      const res = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ username, password, twoFactorCode: code });
      expect(res.status).toBe(201);
      expect(res.body.requiresTwoFactor).toBe(false);
      expect(extractCookie(res.headers["set-cookie"], "korrelo_token")).toBeTruthy();
    });

    it("login com um backup code funciona (uso único)", async () => {
      const backupCode = backupCodes[0];
      const res = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ username, password, twoFactorCode: backupCode });
      expect(res.status).toBe(201);
      expect(res.body.requiresTwoFactor).toBe(false);
    });

    it("reusar o mesmo backup code é rejeitado", async () => {
      const backupCode = backupCodes[0];
      const res = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ username, password, twoFactorCode: backupCode });
      expect(res.status).toBe(401);
    });

    it("desativa o 2FA com a senha", async () => {
      const res = await request(app.getHttpServer())
        .post("/auth/2fa/disable")
        .set("Cookie", [`korrelo_token=${accessCookie}`])
        .send({ password });
      expect(res.status).toBe(201);

      const status = await request(app.getHttpServer())
        .get("/auth/2fa/status")
        .set("Cookie", [`korrelo_token=${accessCookie}`]);
      expect(status.body).toEqual({ enabled: false });
    });
  });

  describe("sessões ativas", () => {
    let userACookie: string;
    let userARefreshCookie: string;
    let otherUserCookie: string;

    beforeAll(async () => {
      const login1 = await request(app.getHttpServer())
        .post("/auth/login")
        .set("User-Agent", "chrome-e2e-test")
        .send({ username, password });
      userACookie = extractCookie(login1.headers["set-cookie"], "korrelo_token")!;
      userARefreshCookie = extractCookie(login1.headers["set-cookie"], "korrelo_refresh_token")!;

      await request(app.getHttpServer())
        .post("/auth/login")
        .set("User-Agent", "safari-e2e-test")
        .send({ username, password });

      // segundo usuário, inserido direto no banco (o endpoint de registro só
      // permite o primeiro usuário), pra testar isolamento entre contas.
      const prisma = new PrismaService();
      await prisma.$connect();
      const passwordHash = await bcrypt.hash("outra-senha-123", 10);
      await prisma.user.create({
        data: { username: "outro-usuario@e2e-test.local", passwordHash },
      });
      await prisma.$disconnect();

      const login2 = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ username: "outro-usuario@e2e-test.local", password: "outra-senha-123" });
      otherUserCookie = extractCookie(login2.headers["set-cookie"], "korrelo_token")!;
    });

    it("lista as sessões do usuário A (incluindo chrome e safari), marcando a atual", async () => {
      const res = await request(app.getHttpServer())
        .get("/auth/sessions")
        .set("Cookie", [`korrelo_token=${userACookie}`, `korrelo_refresh_token=${userARefreshCookie}`]);

      expect(res.status).toBe(200);
      // O mesmo usuário já acumulou sessões de testes anteriores neste arquivo
      // (register + logins do fluxo de 2FA). Aqui só garantimos que as duas
      // sessões criadas NESTE describe (chrome/safari) aparecem, sem exigir
      // uma contagem exata do total.
      const chromeSession = res.body.find((s: { userAgent: string }) => s.userAgent === "chrome-e2e-test");
      const safariSession = res.body.find((s: { userAgent: string }) => s.userAgent === "safari-e2e-test");
      expect(chromeSession).toBeTruthy();
      expect(safariSession).toBeTruthy();
      expect(chromeSession.isCurrent).toBe(true);
      expect(safariSession.isCurrent).toBe(false);
    });

    it("usuário A não consegue revogar sessão do usuário outro (403)", async () => {
      const otherSessions = await request(app.getHttpServer())
        .get("/auth/sessions")
        .set("Cookie", [`korrelo_token=${otherUserCookie}`]);
      const otherSessionId = otherSessions.body[0].id;

      const res = await request(app.getHttpServer())
        .delete(`/auth/sessions/${otherSessionId}`)
        .set("Cookie", [`korrelo_token=${userACookie}`]);
      expect(res.status).toBe(403);
    });

    it("revogar uma sessão inexistente dá 404", async () => {
      const res = await request(app.getHttpServer())
        .delete(`/auth/sessions/00000000-0000-0000-0000-000000000000`)
        .set("Cookie", [`korrelo_token=${userACookie}`]);
      expect(res.status).toBe(404);
    });

    it("usuário A revoga a sessão do safari e ela some da lista", async () => {
      const before = await request(app.getHttpServer())
        .get("/auth/sessions")
        .set("Cookie", [`korrelo_token=${userACookie}`]);
      const safariSession = before.body.find((s: { userAgent: string }) => s.userAgent === "safari-e2e-test");
      expect(safariSession).toBeTruthy();

      const del = await request(app.getHttpServer())
        .delete(`/auth/sessions/${safariSession.id}`)
        .set("Cookie", [`korrelo_token=${userACookie}`]);
      expect(del.status).toBe(200);

      const after = await request(app.getHttpServer())
        .get("/auth/sessions")
        .set("Cookie", [`korrelo_token=${userACookie}`]);
      expect(after.body.find((s: { userAgent: string }) => s.userAgent === "safari-e2e-test")).toBeUndefined();
    });
  });
});
