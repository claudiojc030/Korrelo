import { Injectable } from "@nestjs/common";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { DetectedStack } from "../domain/detected-stack";
import type { StackDetector } from "../domain/stack-detector";

interface FrameworkRule {
  framework: string;
  dependency: string;
  defaultPort: number;
  startScript: string;
  buildScript: string | null;
}

const NODE_FRAMEWORK_RULES: FrameworkRule[] = [
  { framework: "Next.js", dependency: "next", defaultPort: 3000, startScript: "start", buildScript: "build" },
  { framework: "NestJS", dependency: "@nestjs/core", defaultPort: 3000, startScript: "start:prod", buildScript: "build" },
  { framework: "Angular", dependency: "@angular/core", defaultPort: 4200, startScript: "start", buildScript: "build" },
  { framework: "Nuxt", dependency: "nuxt", defaultPort: 3000, startScript: "start", buildScript: "build" },
  { framework: "Vue", dependency: "vue", defaultPort: 5173, startScript: "preview", buildScript: "build" },
  { framework: "Fastify", dependency: "fastify", defaultPort: 3000, startScript: "start", buildScript: null },
  { framework: "Express", dependency: "express", defaultPort: 3000, startScript: "start", buildScript: null },
  { framework: "React", dependency: "react", defaultPort: 3000, startScript: "start", buildScript: "build" },
];

function scriptCommand(packageManager: string, script: string): string {
  switch (packageManager) {
    case "yarn":
      return `yarn ${script}`;
    case "pnpm":
      return `pnpm ${script}`;
    case "bun":
      return `bun run ${script}`;
    default:
      return `npm run ${script}`;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readTextLower(filePath: string): Promise<string> {
  try {
    return (await fs.readFile(filePath, "utf-8")).toLowerCase();
  } catch {
    return "";
  }
}

async function findFileByExtension(projectPath: string, extension: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(projectPath);
    return entries.find((entry) => entry.toLowerCase().endsWith(extension)) ?? null;
  } catch {
    return null;
  }
}

@Injectable()
export class FileBasedStackDetector implements StackDetector {
  async detect(projectPath: string): Promise<DetectedStack> {
    const packageJsonPath = path.join(projectPath, "package.json");
    if (await fileExists(packageJsonPath)) {
      return this.detectNode(projectPath, packageJsonPath);
    }

    if (await fileExists(path.join(projectPath, "composer.json"))) {
      return this.detectPhp(projectPath);
    }

    if (
      (await fileExists(path.join(projectPath, "requirements.txt"))) ||
      (await fileExists(path.join(projectPath, "pyproject.toml")))
    ) {
      return this.detectPython(projectPath);
    }

    if (await fileExists(path.join(projectPath, "go.mod"))) {
      return this.detectGo(projectPath);
    }

    if (await fileExists(path.join(projectPath, "Cargo.toml"))) {
      return this.detectRust(projectPath);
    }

    if (await fileExists(path.join(projectPath, "pom.xml"))) {
      return this.detectJava(projectPath, "maven");
    }
    if (
      (await fileExists(path.join(projectPath, "build.gradle"))) ||
      (await fileExists(path.join(projectPath, "build.gradle.kts")))
    ) {
      return this.detectJava(projectPath, "gradle");
    }

    if (await findFileByExtension(projectPath, ".csproj")) {
      return this.detectDotnet();
    }

    return this.unknownStack("Desconhecida");
  }

  private async detectNode(projectPath: string, packageJsonPath: string): Promise<DetectedStack> {
    const packageJson = (await readJson(packageJsonPath)) ?? {};
    const deps = {
      ...(packageJson.dependencies as Record<string, string> | undefined),
      ...(packageJson.devDependencies as Record<string, string> | undefined),
    };

    const rule = NODE_FRAMEWORK_RULES.find((r) => deps[r.dependency] !== undefined);
    const packageManager = await this.detectNodePackageManager(projectPath);

    if (!rule) {
      return {
        language: "Node.js",
        framework: null,
        packageManager,
        recommendedPort: 3000,
        startCommand: scriptCommand(packageManager, "start"),
        buildCommand: null,
        entryPoint: null,
      };
    }

    return {
      language: "Node.js",
      framework: rule.framework,
      packageManager,
      recommendedPort: rule.defaultPort,
      startCommand: scriptCommand(packageManager, rule.startScript),
      buildCommand: rule.buildScript ? scriptCommand(packageManager, rule.buildScript) : null,
      entryPoint: null,
    };
  }

  private async detectNodePackageManager(projectPath: string): Promise<string> {
    if (await fileExists(path.join(projectPath, "pnpm-lock.yaml"))) return "pnpm";
    if (await fileExists(path.join(projectPath, "yarn.lock"))) return "yarn";
    if (await fileExists(path.join(projectPath, "bun.lockb"))) return "bun";
    return "npm";
  }

  private async detectPhp(projectPath: string): Promise<DetectedStack> {
    const composerJson = (await readJson(path.join(projectPath, "composer.json"))) ?? {};
    const require = (composerJson.require as Record<string, string> | undefined) ?? {};
    const isLaravel = require["laravel/framework"] !== undefined;

    return {
      language: "PHP",
      framework: isLaravel ? "Laravel" : null,
      packageManager: "composer",
      recommendedPort: 8000,
      startCommand: isLaravel ? "php artisan serve --host=0.0.0.0 --port=8000" : "php -S 0.0.0.0:8000",
      buildCommand: null,
      entryPoint: null,
    };
  }

  private async detectPython(projectPath: string): Promise<DetectedStack> {
    const requirements = await readTextLower(path.join(projectPath, "requirements.txt"));

    const framework = requirements.includes("django")
      ? "Django"
      : requirements.includes("flask")
        ? "Flask"
        : requirements.includes("fastapi")
          ? "FastAPI"
          : null;

    // Muito projeto Flask/FastAPI de exemplo (Heroku/Render etc) não chama
    // app.run() no próprio arquivo — espera rodar via gunicorn/uvicorn como
    // processo web "de produção". "python app.py" nesses casos não sobe nada.
    const hasGunicorn = requirements.includes("gunicorn");

    let startCommand: string;
    let port: number;
    if (framework === "Django") {
      startCommand = "python manage.py runserver 0.0.0.0:8000";
      port = 8000;
    } else if (framework === "FastAPI") {
      startCommand = "uvicorn main:app --host 0.0.0.0 --port 5000";
      port = 5000;
    } else if (hasGunicorn) {
      // Convenção comum: app.py com uma variável `app = Flask(__name__)`.
      startCommand = "gunicorn app:app --bind 0.0.0.0:5000";
      port = 5000;
    } else {
      startCommand = "python app.py";
      port = 5000;
    }

    return {
      language: "Python",
      framework,
      packageManager: "pip",
      recommendedPort: port,
      startCommand,
      buildCommand: null,
      entryPoint: null,
    };
  }

  private async detectGo(projectPath: string): Promise<DetectedStack> {
    const goMod = await readTextLower(path.join(projectPath, "go.mod"));
    const framework = goMod.includes("gin-gonic/gin")
      ? "Gin"
      : goMod.includes("labstack/echo")
        ? "Echo"
        : goMod.includes("gofiber/fiber")
          ? "Fiber"
          : null;

    return {
      language: "Go",
      framework,
      packageManager: "go",
      recommendedPort: 8080,
      startCommand: null,
      buildCommand: null,
      entryPoint: null,
    };
  }

  private async detectRust(projectPath: string): Promise<DetectedStack> {
    const cargoToml = await readTextLower(path.join(projectPath, "Cargo.toml"));
    const nameMatch = cargoToml.match(/name\s*=\s*"([a-z0-9_-]+)"/);
    const entryPoint = nameMatch ? nameMatch[1] : "app";
    const framework = cargoToml.includes("actix-web")
      ? "Actix Web"
      : cargoToml.includes("axum")
        ? "Axum"
        : cargoToml.includes("rocket")
          ? "Rocket"
          : null;

    return {
      language: "Rust",
      framework,
      packageManager: "cargo",
      recommendedPort: 8080,
      startCommand: null,
      buildCommand: null,
      entryPoint,
    };
  }

  private async detectJava(projectPath: string, buildTool: "maven" | "gradle"): Promise<DetectedStack> {
    const manifestFile = buildTool === "maven" ? "pom.xml" : "build.gradle";
    const manifest = await readTextLower(path.join(projectPath, manifestFile));
    const isSpringBoot = manifest.includes("spring-boot");

    return {
      language: "Java",
      framework: isSpringBoot ? "Spring Boot" : null,
      packageManager: buildTool,
      recommendedPort: 8080,
      startCommand: null,
      buildCommand: null,
      entryPoint: null,
    };
  }

  private detectDotnet(): DetectedStack {
    return {
      language: ".NET",
      framework: "ASP.NET Core",
      packageManager: "dotnet",
      recommendedPort: 8080,
      startCommand: null,
      buildCommand: null,
      entryPoint: null,
    };
  }

  private unknownStack(language: string): DetectedStack {
    return {
      language,
      framework: null,
      packageManager: null,
      recommendedPort: null,
      startCommand: null,
      buildCommand: null,
      entryPoint: null,
    };
  }
}
