import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileBasedStackDetector } from "./file-based-stack-detector";

async function makeFixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "korrelo-detect-"));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content, "utf-8");
  }
  return dir;
}

describe("FileBasedStackDetector", () => {
  const detector = new FileBasedStackDetector();
  const tempDirs: string[] = [];

  afterAll(async () => {
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function withFixture(files: Record<string, string>) {
    const dir = await makeFixture(files);
    tempDirs.push(dir);
    return dir;
  }

  it("detecta Next.js com npm", async () => {
    const dir = await withFixture({
      "package.json": JSON.stringify({
        name: "app",
        dependencies: { next: "^14.0.0", react: "^18.0.0" },
      }),
      "package-lock.json": "{}",
    });

    const result = await detector.detect(dir);

    expect(result).toEqual({
      language: "Node.js",
      framework: "Next.js",
      packageManager: "npm",
      recommendedPort: 3000,
      startCommand: "npm run start",
      buildCommand: "npm run build",
      entryPoint: null,
    });
  });

  it("detecta NestJS com pnpm e usa o script start:prod", async () => {
    const dir = await withFixture({
      "package.json": JSON.stringify({
        name: "api",
        dependencies: { "@nestjs/core": "^10.0.0" },
      }),
      "pnpm-lock.yaml": "",
    });

    const result = await detector.detect(dir);

    expect(result.framework).toBe("NestJS");
    expect(result.packageManager).toBe("pnpm");
    expect(result.startCommand).toBe("pnpm start:prod");
    expect(result.buildCommand).toBe("pnpm build");
  });

  it("detecta Express com yarn e sem framework de build", async () => {
    const dir = await withFixture({
      "package.json": JSON.stringify({
        name: "api-simples",
        dependencies: { express: "^4.18.0" },
      }),
      "yarn.lock": "",
    });

    const result = await detector.detect(dir);

    expect(result.framework).toBe("Express");
    expect(result.packageManager).toBe("yarn");
    expect(result.startCommand).toBe("yarn start");
    expect(result.buildCommand).toBeNull();
  });

  it("detecta Laravel via composer.json", async () => {
    const dir = await withFixture({
      "composer.json": JSON.stringify({ require: { php: "^8.2", "laravel/framework": "^11.0" } }),
    });

    const result = await detector.detect(dir);

    expect(result).toEqual({
      language: "PHP",
      framework: "Laravel",
      packageManager: "composer",
      recommendedPort: 8000,
      startCommand: "php artisan serve --host=0.0.0.0 --port=8000",
      buildCommand: null,
      entryPoint: null,
    });
  });

  it("detecta Django via requirements.txt", async () => {
    const dir = await withFixture({
      "requirements.txt": "Django==5.0\npsycopg2-binary==2.9\n",
    });

    const result = await detector.detect(dir);

    expect(result.language).toBe("Python");
    expect(result.framework).toBe("Django");
    expect(result.startCommand).toBe("python manage.py runserver 0.0.0.0:8000");
  });

  it("detecta Flask com Gunicorn no requirements.txt e usa gunicorn como start command", async () => {
    const dir = await withFixture({
      "requirements.txt": "Flask\nGunicorn\n",
      "app.py": "from flask import Flask\napp = Flask(__name__)\n",
    });

    const result = await detector.detect(dir);

    expect(result.framework).toBe("Flask");
    expect(result.startCommand).toBe("gunicorn app:app --bind 0.0.0.0:5000");
  });

  it("detecta Go com framework Gin via go.mod", async () => {
    const dir = await withFixture({
      "go.mod": "module exemplo.com/app\n\nrequire github.com/gin-gonic/gin v1.9.0\n",
    });

    const result = await detector.detect(dir);

    expect(result.language).toBe("Go");
    expect(result.framework).toBe("Gin");
    expect(result.recommendedPort).toBe(8080);
  });

  it("detecta Rust e extrai o nome do pacote do Cargo.toml", async () => {
    const dir = await withFixture({
      "Cargo.toml": '[package]\nname = "meu-servidor"\nversion = "0.1.0"\n\n[dependencies]\naxum = "0.7"\n',
    });

    const result = await detector.detect(dir);

    expect(result.language).toBe("Rust");
    expect(result.framework).toBe("Axum");
    expect(result.entryPoint).toBe("meu-servidor");
  });

  it("detecta Java com Spring Boot via pom.xml (Maven)", async () => {
    const dir = await withFixture({
      "pom.xml": "<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>",
    });

    const result = await detector.detect(dir);

    expect(result.language).toBe("Java");
    expect(result.framework).toBe("Spring Boot");
    expect(result.packageManager).toBe("maven");
  });

  it("detecta .NET via arquivo .csproj", async () => {
    const dir = await withFixture({
      "MinhaApi.csproj": "<Project Sdk=\"Microsoft.NET.Sdk.Web\"></Project>",
    });

    const result = await detector.detect(dir);

    expect(result.language).toBe(".NET");
    expect(result.packageManager).toBe("dotnet");
  });

  it("retorna 'Desconhecida' quando nenhum arquivo reconhecido existe", async () => {
    const dir = await withFixture({ "README.md": "sem stack aqui" });

    const result = await detector.detect(dir);

    expect(result.language).toBe("Desconhecida");
    expect(result.framework).toBeNull();
  });
});
