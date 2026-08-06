import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request from "supertest";

// Testes de integração de verdade pro ProjectsModule: sobem o módulo inteiro
// via @nestjs/testing + supertest contra um SQLite temporário (nunca o
// dev.db real). Diferente do auth e2e, esse módulo toca infraestrutura real
// (docker exec, docker compose, git clone, nginx/certbot, alocação de porta).
// TODAS essas bordas são substituídas por fakes via overrideProvider(), então
// nenhum container, repositório git ou configuração de nginx de verdade é
// tocado. O workspace de arquivos (Dockerfile, compose, .env) usa uma pasta
// temporária isolada (KORRELO_WORKSPACE_DIR), então essa parte É testada
// de verdade (é só leitura/escrita em disco, sem risco).
jest.setTimeout(30_000);

const PRISMA_DIR = path.join(__dirname, "../../../../prisma");
const dbFileName = `.e2e-projects-${crypto.randomUUID()}.db`;
const dbPath = path.join(PRISMA_DIR, dbFileName);
const databaseUrl = `file:./${dbFileName}`;
const tempWorkspaceDir = path.join(os.tmpdir(), `korrelo-e2e-workspace-${crypto.randomUUID()}`);

interface DeployConfigLike {
  projectPath: string;
  containerName: string;
  hostPort: number;
  containerPort: number;
}

class FakeContainerOrchestrator {
  deployCalls: DeployConfigLike[] = [];
  teardownCalls: { projectPath: string; containerName: string }[] = [];
  shouldFailDeploy = false;

  async deploy(config: DeployConfigLike): Promise<void> {
    this.deployCalls.push(config);
    if (this.shouldFailDeploy) {
      throw new Error("fake deploy failure (teste)");
    }
  }

  async teardown(config: { projectPath: string; containerName: string }): Promise<void> {
    this.teardownCalls.push(config);
  }
}

class FakeHealthChecker {
  shouldBeHealthy = true;
  async waitUntilHealthy(): Promise<boolean> {
    return this.shouldBeHealthy;
  }
}

class FakeLogReader {
  async readLogs(containerName: string): Promise<string> {
    return `fake logs for ${containerName}`;
  }
}

class FakeDomainProvisioner {
  attachCalls: { domain: string; port: number; adminEmail: string }[] = [];
  detachCalls: { domain: string }[] = [];
  async attach(domain: string, port: number, adminEmail: string): Promise<void> {
    this.attachCalls.push({ domain, port, adminEmail });
  }
  async detach(domain: string): Promise<void> {
    this.detachCalls.push({ domain });
  }
}

class FakeCronJobRunner {
  async run(containerName: string, command: string) {
    return { status: "success" as const, output: `ran "${command}" on ${containerName}` };
  }
}

class FakeDatabaseQueryRunner {
  async listTables() {
    return ["fake_table"];
  }
  async runQuery() {
    return { columns: ["col"], rows: [["value"]], rowCount: 1, notice: null };
  }
}

class FakeRepositoryCloner {
  // Nunca clona de verdade, só cria o diretório de destino (como um clone
  // real faria) e larga um package.json mínimo, o suficiente pro
  // FileBasedStackDetector (esse sim real) detectar uma stack Node/Express.
  async cloneOrUpdate(_repoUrl: string, destPath: string): Promise<void> {
    fs.mkdirSync(destPath, { recursive: true });
    fs.writeFileSync(
      path.join(destPath, "package.json"),
      JSON.stringify({
        name: "fixture-app",
        dependencies: { express: "^4.0.0" },
        scripts: { start: "node server.js" },
      }),
    );
  }

  async getCurrentBranch(): Promise<string | null> {
    return "main";
  }
}

function extractCookie(setCookieHeader: string | string[] | undefined, name: string): string | null {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
  const line = headers.find((c) => c.startsWith(`${name}=`));
  if (!line) return null;
  return line.split(";")[0].split("=")[1];
}

describe("Projects flow (e2e)", () => {
  let app: INestApplication;
  let authCookie: string;
  const fakeOrchestrator = new FakeContainerOrchestrator();
  const fakeHealthChecker = new FakeHealthChecker();
  const fakeDomainProvisioner = new FakeDomainProvisioner();

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.JWT_SECRET = "e2e-test-secret-not-for-production-use";
    process.env.JWT_EXPIRES_IN = "15m";
    process.env.ENV_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
    process.env.KORRELO_WORKSPACE_DIR = tempWorkspaceDir;
    fs.mkdirSync(tempWorkspaceDir, { recursive: true });

    const prismaCli = require.resolve("prisma/build/index.js");
    execFileSync(process.execPath, [prismaCli, "db", "push", "--skip-generate"], {
      cwd: path.join(__dirname, "../../../.."),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    });

    // require() dinâmico DEPOIS de setar KORRELO_WORKSPACE_DIR: o caminho do
    // workspace (infrastructure/workspace-paths.ts) é uma constante de módulo
    // resolvida na primeira vez que o arquivo é importado. Um `import`
    // estático no topo deste arquivo rodaria antes do beforeAll (imports são
    // hoisted), capturando o valor errado da env var.
    const { ProjectsModule } = require("../projects.module");
    const { CONTAINER_ORCHESTRATOR } = require("../domain/container-orchestrator");
    const { HEALTH_CHECKER } = require("../domain/health-checker");
    const { LOG_READER } = require("../domain/log-reader");
    const { DOMAIN_PROVISIONER } = require("../domain/domain-provisioner");
    const { CRON_JOB_RUNNER } = require("../domain/cron-job-runner");
    const { DATABASE_QUERY_RUNNER } = require("../domain/database-query-runner");
    const { REPOSITORY_CLONER } = require("../domain/repository-cloner");
    const { PortAllocator } = require("../infrastructure/port-allocator");

    const moduleFixture = await Test.createTestingModule({ imports: [ProjectsModule] })
      .overrideProvider(CONTAINER_ORCHESTRATOR)
      .useValue(fakeOrchestrator)
      .overrideProvider(HEALTH_CHECKER)
      .useValue(fakeHealthChecker)
      .overrideProvider(LOG_READER)
      .useValue(new FakeLogReader())
      .overrideProvider(DOMAIN_PROVISIONER)
      .useValue(fakeDomainProvisioner)
      .overrideProvider(CRON_JOB_RUNNER)
      .useValue(new FakeCronJobRunner())
      .overrideProvider(DATABASE_QUERY_RUNNER)
      .useValue(new FakeDatabaseQueryRunner())
      .overrideProvider(REPOSITORY_CLONER)
      .useValue(new FakeRepositoryCloner())
      .overrideProvider(PortAllocator)
      .useValue({ allocate: async () => 39999 })
      .compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    await app.init();

    // O guard global do AuthModule (importado transitivamente pelo
    // ProjectsModule) exige um token válido em quase toda rota.
    const register = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ username: "admin-e2e-projects", password: "senha-super-forte-123" });
    authCookie = extractCookie(register.headers["set-cookie"], "korrelo_token")!;
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-journal`, { force: true });
    fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
  });

  function authCookieHeader(): string {
    return `korrelo_token=${authCookie}`;
  }

  describe("CRUD básico de projetos", () => {
    let projectId: string;

    it("cria um projeto", async () => {
      const res = await request(app.getHttpServer())
        .post("/projects")
        .set("Cookie", [authCookieHeader()])
        .send({ name: "Meu Projeto", repoUrl: "https://github.com/exemplo/meu-projeto.git" });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe("Meu Projeto");
      expect(res.body.status).toBe("detected");
      expect(res.body.containerName).toBeNull();
      projectId = res.body.id;
    });

    it("lista projetos e inclui o recém-criado", async () => {
      const res = await request(app.getHttpServer()).get("/projects").set("Cookie", [authCookieHeader()]);
      expect(res.status).toBe(200);
      expect(res.body.find((p: { id: string }) => p.id === projectId)).toBeTruthy();
    });

    it("busca por id, e 404 pra id inexistente", async () => {
      const found = await request(app.getHttpServer())
        .get(`/projects/${projectId}`)
        .set("Cookie", [authCookieHeader()]);
      expect(found.status).toBe(200);

      const notFound = await request(app.getHttpServer())
        .get(`/projects/00000000-0000-0000-0000-000000000000`)
        .set("Cookie", [authCookieHeader()]);
      expect(notFound.status).toBe(404);
    });

    it("atualiza configurações (terminal/database habilitados)", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/projects/${projectId}/settings`)
        .set("Cookie", [authCookieHeader()])
        .send({ terminalEnabled: false, databaseEnabled: true });
      expect(res.status).toBe(200);
      expect(res.body.terminalEnabled).toBe(false);
    });

    it("seta e lista variáveis de ambiente (round-trip de cifra real)", async () => {
      const setRes = await request(app.getHttpServer())
        .put(`/projects/${projectId}/env`)
        .set("Cookie", [authCookieHeader()])
        .send({ vars: [{ key: "API_KEY", value: "segredo-123" }] });
      expect(setRes.status).toBe(200);

      const getRes = await request(app.getHttpServer())
        .get(`/projects/${projectId}/env`)
        .set("Cookie", [authCookieHeader()]);
      expect(getRes.status).toBe(200);
      const apiKeyVar = getRes.body.find((v: { key: string }) => v.key === "API_KEY");
      expect(apiKeyVar.value).toBe("segredo-123");
    });
  });

  describe("banco de dados gerenciado (metadata pura, sem container)", () => {
    let projectId: string;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .post("/projects")
        .set("Cookie", [authCookieHeader()])
        .send({ name: "Projeto com Banco", repoUrl: "https://github.com/exemplo/com-banco.git" });
      projectId = res.body.id;
    });

    it("provisiona um postgres gerenciado", async () => {
      const res = await request(app.getHttpServer())
        .post(`/projects/${projectId}/database`)
        .set("Cookie", [authCookieHeader()])
        .send({ type: "postgres" });
      expect(res.status).toBe(201);
      expect(res.body.type).toBe("postgres");
      expect(res.body.password).toEqual(expect.any(String));
    });

    it("recusa provisionar um segundo banco pro mesmo projeto", async () => {
      const res = await request(app.getHttpServer())
        .post(`/projects/${projectId}/database`)
        .set("Cookie", [authCookieHeader()])
        .send({ type: "redis" });
      expect(res.status).toBe(409);
    });

    it("remove o banco gerenciado", async () => {
      const del = await request(app.getHttpServer())
        .delete(`/projects/${projectId}/database`)
        .set("Cookie", [authCookieHeader()]);
      expect(del.status).toBe(204);

      const get = await request(app.getHttpServer())
        .get(`/projects/${projectId}/database`)
        .set("Cookie", [authCookieHeader()]);
      expect(get.status).toBe(200);
      expect(get.body?.id).toBeUndefined();
    });
  });

  describe("cron jobs", () => {
    let projectId: string;
    let jobId: string;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .post("/projects")
        .set("Cookie", [authCookieHeader()])
        .send({ name: "Projeto com Cron", repoUrl: "https://github.com/exemplo/com-cron.git" });
      projectId = res.body.id;
    });

    it("cria um cron job", async () => {
      const res = await request(app.getHttpServer())
        .post(`/projects/${projectId}/cron`)
        .set("Cookie", [authCookieHeader()])
        .send({ name: "Limpeza diária", command: "echo limpando", schedule: "0 3 * * *" });
      expect(res.status).toBe(201);
      expect(res.body.enabled).toBe(true);
      jobId = res.body.id;
    });

    it("lista os cron jobs do projeto", async () => {
      const res = await request(app.getHttpServer())
        .get(`/projects/${projectId}/cron`)
        .set("Cookie", [authCookieHeader()]);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it("atualiza o cron job", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/projects/${projectId}/cron/${jobId}`)
        .set("Cookie", [authCookieHeader()])
        .send({ enabled: false });
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false);
    });

    it("apaga o cron job", async () => {
      const del = await request(app.getHttpServer())
        .delete(`/projects/${projectId}/cron/${jobId}`)
        .set("Cookie", [authCookieHeader()]);
      expect(del.status).toBe(204);

      const list = await request(app.getHttpServer())
        .get(`/projects/${projectId}/cron`)
        .set("Cookie", [authCookieHeader()]);
      expect(list.body).toHaveLength(0);
    });
  });

  describe("detecção de stack + deploy (com fakes de infraestrutura)", () => {
    let projectId: string;
    let fixtureDir: string;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .post("/projects")
        .set("Cookie", [authCookieHeader()])
        .send({ name: "Projeto pra Deploy", repoUrl: "https://github.com/exemplo/pra-deploy.git" });
      projectId = res.body.id;

      // fixture real e isolada (não é o repositório de ninguém) só pra
      // exercitar o FileBasedStackDetector de verdade, é só leitura de
      // arquivo, sem risco nenhum.
      fixtureDir = path.join(tempWorkspaceDir, "fixture-node-express");
      fs.mkdirSync(fixtureDir, { recursive: true });
      fs.writeFileSync(
        path.join(fixtureDir, "package.json"),
        JSON.stringify({
          name: "fixture-app",
          dependencies: { express: "^4.0.0" },
          scripts: { start: "node server.js" },
        }),
      );
    });

    it("detecta a stack a partir de um diretório real (endpoint isolado, sem import)", async () => {
      const res = await request(app.getHttpServer())
        .post(`/projects/${projectId}/detect-stack`)
        .set("Cookie", [authCookieHeader()])
        .send({ path: fixtureDir });
      expect(res.status).toBe(201);
      const stack = JSON.parse(res.body.detectedStack);
      expect(stack.language).toBe("Node.js");
      expect(stack.framework).toBe("Express");
    });

    it("importa o projeto (clona via fake + detecta stack de verdade) e faz o deploy com sucesso", async () => {
      // /import cria o workspace do projeto (o fake cloner faz mkdir + larga
      // um package.json), sem isso não existe pasta pro deploy escrever
      // Dockerfile/compose/env, igual aconteceria com um clone de verdade
      // que nunca rodou.
      const imported = await request(app.getHttpServer())
        .post(`/projects/${projectId}/import`)
        .set("Cookie", [authCookieHeader()]);
      expect(imported.status).toBe(201);
      expect(JSON.parse(imported.body.detectedStack).framework).toBe("Express");

      const res = await request(app.getHttpServer())
        .post(`/projects/${projectId}/deploy`)
        .set("Cookie", [authCookieHeader()]);

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("running");
      expect(res.body.containerName).toEqual(expect.any(String));
      expect(res.body.assignedPort).toBe(39999);

      const projectWorkspace = path.join(tempWorkspaceDir, projectId);
      expect(fs.existsSync(path.join(projectWorkspace, "Dockerfile"))).toBe(true);
      expect(fs.existsSync(path.join(projectWorkspace, "docker-compose.korrelo.yml"))).toBe(true);
      expect(fs.existsSync(path.join(projectWorkspace, ".env.korrelo"))).toBe(true);

      const deploys = await request(app.getHttpServer())
        .get(`/projects/${projectId}/deploys`)
        .set("Cookie", [authCookieHeader()]);
      expect(deploys.body[0].status).toBe("success");
    });

    it("faz rollback quando o orchestrator falha ao subir o container", async () => {
      const failing = await request(app.getHttpServer())
        .post("/projects")
        .set("Cookie", [authCookieHeader()])
        .send({ name: "Projeto que Falha", repoUrl: "https://github.com/exemplo/falha.git" });
      const failingId = failing.body.id;

      await request(app.getHttpServer())
        .post(`/projects/${failingId}/import`)
        .set("Cookie", [authCookieHeader()]);

      fakeOrchestrator.shouldFailDeploy = true;
      const teardownCallsBefore = fakeOrchestrator.teardownCalls.length;
      const res = await request(app.getHttpServer())
        .post(`/projects/${failingId}/deploy`)
        .set("Cookie", [authCookieHeader()]);
      fakeOrchestrator.shouldFailDeploy = false;

      expect(res.status).toBe(500);
      expect(fakeOrchestrator.teardownCalls.length).toBe(teardownCallsBefore + 1);

      const project = await request(app.getHttpServer())
        .get(`/projects/${failingId}`)
        .set("Cookie", [authCookieHeader()]);
      expect(project.body.status).toBe("failed");

      const deploys = await request(app.getHttpServer())
        .get(`/projects/${failingId}/deploys`)
        .set("Cookie", [authCookieHeader()]);
      expect(deploys.body[0].status).toBe("failed");
    });

    it("faz rollback quando o health check nunca fica saudável", async () => {
      const unhealthy = await request(app.getHttpServer())
        .post("/projects")
        .set("Cookie", [authCookieHeader()])
        .send({ name: "Projeto Doente", repoUrl: "https://github.com/exemplo/doente.git" });
      const unhealthyId = unhealthy.body.id;

      await request(app.getHttpServer())
        .post(`/projects/${unhealthyId}/import`)
        .set("Cookie", [authCookieHeader()]);

      fakeHealthChecker.shouldBeHealthy = false;
      const res = await request(app.getHttpServer())
        .post(`/projects/${unhealthyId}/deploy`)
        .set("Cookie", [authCookieHeader()]);
      fakeHealthChecker.shouldBeHealthy = true;

      expect(res.status).toBe(500);

      const project = await request(app.getHttpServer())
        .get(`/projects/${unhealthyId}`)
        .set("Cookie", [authCookieHeader()]);
      expect(project.body.status).toBe("failed");
    });

    it("lê logs do projeto implantado (via LOG_READER fake)", async () => {
      const res = await request(app.getHttpServer())
        .get(`/projects/${projectId}/logs`)
        .set("Cookie", [authCookieHeader()]);
      expect(res.status).toBe(200);
      expect(res.body.content).toContain("fake logs for");
    });

    it("anexa e remove um domínio (via DOMAIN_PROVISIONER fake)", async () => {
      const attach = await request(app.getHttpServer())
        .post(`/projects/${projectId}/domain`)
        .set("Cookie", [authCookieHeader()])
        .send({ domain: "meuapp.exemplo.com" });
      expect(attach.status).toBe(201);
      expect(attach.body.customDomain).toBe("meuapp.exemplo.com");
      expect(fakeDomainProvisioner.attachCalls).toHaveLength(1);

      const detach = await request(app.getHttpServer())
        .delete(`/projects/${projectId}/domain`)
        .set("Cookie", [authCookieHeader()]);
      expect(detach.status).toBe(200);
      expect(fakeDomainProvisioner.detachCalls).toHaveLength(1);
    });

    it("navega o banco de dados de um projeto implantado (via DATABASE_QUERY_RUNNER fake)", async () => {
      await request(app.getHttpServer())
        .post(`/projects/${projectId}/database`)
        .set("Cookie", [authCookieHeader()])
        .send({ type: "postgres" });

      const tables = await request(app.getHttpServer())
        .get(`/projects/${projectId}/database/tables`)
        .set("Cookie", [authCookieHeader()]);
      expect(tables.status).toBe(200);
      expect(tables.body.tables).toEqual(["fake_table"]);

      const query = await request(app.getHttpServer())
        .post(`/projects/${projectId}/database/query`)
        .set("Cookie", [authCookieHeader()])
        .send({ query: "SELECT 1;" });
      expect(query.status).toBe(201);
      expect(query.body.rows).toEqual([["value"]]);
    });

    it("apaga o projeto: chama teardown, limpa o workspace e some do banco", async () => {
      const projectWorkspace = path.join(tempWorkspaceDir, projectId);
      const teardownCallsBefore = fakeOrchestrator.teardownCalls.length;

      const del = await request(app.getHttpServer())
        .delete(`/projects/${projectId}`)
        .set("Cookie", [authCookieHeader()]);
      expect(del.status).toBe(204);

      expect(fakeOrchestrator.teardownCalls.length).toBe(teardownCallsBefore + 1);
      expect(fs.existsSync(projectWorkspace)).toBe(false);

      const get = await request(app.getHttpServer())
        .get(`/projects/${projectId}`)
        .set("Cookie", [authCookieHeader()]);
      expect(get.status).toBe(404);
    });
  });
});
