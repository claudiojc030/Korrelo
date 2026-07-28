import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileBasedStackDetector } from "./file-based-stack-detector";

async function makeFixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forgedesk-detect-"));
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
      startCommand: "php artisan serve",
      buildCommand: null,
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

  it("retorna 'Desconhecida' quando nenhum arquivo reconhecido existe", async () => {
    const dir = await withFixture({ "README.md": "sem stack aqui" });

    const result = await detector.detect(dir);

    expect(result.language).toBe("Desconhecida");
    expect(result.framework).toBeNull();
  });
});
